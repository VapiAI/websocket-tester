import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'http';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.VAPI_API_KEY ?? '';
const API_URL = process.env.VAPI_API_URL ?? 'https://api.vapi.ai';
const DEFAULT_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID ?? '';
const PORT = parseInt(process.env.PORT ?? '8000', 10);

if (!API_KEY) {
  console.error('Error: VAPI_API_KEY is not set. Copy .env.example to .env and fill in your API key.');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static('dist/client'));
app.use(express.static('public'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// sessionId -> vapiWsUrl, kept until client connects
const pendingSessions = new Map<string, string>();

interface StartCallBody {
  assistantId?: string;
  assistantOverrides?: Record<string, unknown>;
  name?: string;
  metadata?: Record<string, unknown>;
}

app.post('/api/start-call', async (req, res) => {
  try {
    const url = `${API_URL}/call`;
    const body: StartCallBody = req.body ?? {};
    const assistantId = body.assistantId ?? DEFAULT_ASSISTANT_ID;

    if (!assistantId) {
      res.status(400).json({ error: 'assistantId is required — set VAPI_ASSISTANT_ID in .env or pass it in the request body' });
      return;
    }

    const callPayload: Record<string, unknown> = {
      assistantId,
      transport: {
        provider: 'vapi.websocket',
        audioFormat: {
          format: 'pcm_s16le',
          container: 'raw',
          sampleRate: 16000,
        },
      },
    };
    if (body.assistantOverrides) callPayload.assistantOverrides = body.assistantOverrides;
    if (body.name) callPayload.name = body.name;
    if (body.metadata) callPayload.metadata = body.metadata;

    console.log('POST %s payload=%s', url, JSON.stringify(callPayload));
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(callPayload),
    });

    const responseText = await response.text();
    if (!response.ok) {
      console.error('Vapi API error:', response.status, responseText);
      res.status(response.status).json({ error: responseText });
      return;
    }

    const call = JSON.parse(responseText);
    const vapiWsUrl: string | undefined = call.transport?.websocketCallUrl;

    if (!vapiWsUrl) {
      console.error('No websocketCallUrl in response:', JSON.stringify(call, null, 2));
      res.status(500).json({ error: 'No websocketCallUrl in Vapi response', call });
      return;
    }

    pendingSessions.set(call.id, vapiWsUrl);
    console.log(`Call created: ${call.id} -> ${vapiWsUrl}`);

    res.json({
      callId: call.id,
      sessionId: call.id,
      status: call.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('start-call error:', message);
    res.status(500).json({ error: message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ defaultAssistantId: DEFAULT_ASSISTANT_ID });
});

wss.on('connection', (clientWs: WebSocket, req: IncomingMessage) => {
  const urlStr = req.url ?? '';
  const url = new URL(urlStr, `http://localhost`);
  const sessionId = url.searchParams.get('session');

  if (!sessionId || !pendingSessions.has(sessionId)) {
    clientWs.close(4000, 'Invalid or expired session');
    return;
  }

  const vapiWsUrl = pendingSessions.get(sessionId)!;
  pendingSessions.delete(sessionId);

  console.log(`Proxying session ${sessionId} to ${vapiWsUrl}`);

  const vapiWs = new WebSocket(vapiWsUrl, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  const sendToClient = (data: unknown, binary = false) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data as Parameters<typeof clientWs.send>[0], { binary });
    }
  };

  vapiWs.on('open', () => {
    console.log(`Vapi WebSocket open for session ${sessionId}`);
    sendToClient(JSON.stringify({ type: 'proxy.connected', sessionId }));
  });

  vapiWs.on('message', (data, isBinary) => {
    sendToClient(data, isBinary);
  });

  vapiWs.on('close', (code, reason) => {
    const reasonStr = reason.toString() || '(none)';
    console.log(`Vapi WebSocket closed: code=${code} reason=${reasonStr}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      // Codes 1005 (no status) and 1006 (abnormal) are reserved and cannot appear in close frames.
      const safeCode = code === 1005 || code === 1006 || !code ? 1000 : code;
      clientWs.close(safeCode, reasonStr);
    }
  });

  vapiWs.on('error', (err) => {
    console.error('Vapi WebSocket error:', err.message);
    sendToClient(JSON.stringify({ type: 'proxy.error', message: err.message }));
  });

  clientWs.on('message', (data, isBinary) => {
    if (vapiWs.readyState === WebSocket.OPEN) {
      vapiWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('close', () => {
    console.log(`Client disconnected for session ${sessionId}`);
    if (vapiWs.readyState === WebSocket.OPEN || vapiWs.readyState === WebSocket.CONNECTING) {
      vapiWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error('Client WebSocket error:', err.message);
    vapiWs.close();
  });
});

httpServer.listen(PORT, () => {
  console.log(`Vapi WebSocket Tester running at http://localhost:${PORT}`);
  console.log(`API key: ${API_KEY ? '✓ set' : '✗ missing'}`);
  console.log(`Default assistant: ${DEFAULT_ASSISTANT_ID || '(none — set in UI or .env)'}`);
});
