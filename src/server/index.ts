import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage } from 'http';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.VAPI_API_KEY ?? '';
const API_URL = process.env.VAPI_API_URL ?? 'https://api.vapi.ai';
const PORT = parseInt(process.env.PORT ?? '8000', 10);

if (!API_KEY) {
  console.error('Error: VAPI_API_KEY is not set. Copy .env.example to .env and fill in your API key.');
  process.exit(1);
}

// A call targets exactly one of these. Vapi's CreateCallDTO carries a parallel
// id/overrides pair per type, so the type picks which keys the payload uses.
const TARGET_TYPES = ['assistant', 'squad'] as const;
type TargetType = (typeof TARGET_TYPES)[number];

interface Target {
  type: TargetType;
  id: string;
}

function isTargetType(value: unknown): value is TargetType {
  return TARGET_TYPES.includes(value as TargetType);
}

/** Parses `VAPI_DEFAULT_TARGET`, e.g. `squad:5f9b...`. A bare id means assistant. */
function parseDefaultTarget(raw: string): Target | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const sep = trimmed.indexOf(':');
  if (sep === -1) return { type: 'assistant', id: trimmed };

  const type = trimmed.slice(0, sep).trim().toLowerCase();
  const id = trimmed.slice(sep + 1).trim();
  if (!isTargetType(type) || !id) {
    console.warn(
      `Warning: VAPI_DEFAULT_TARGET="${trimmed}" is malformed — expected "<${TARGET_TYPES.join('|')}>:<id>". Ignoring.`,
    );
    return null;
  }
  return { type, id };
}

const DEFAULT_TARGET = parseDefaultTarget(process.env.VAPI_DEFAULT_TARGET ?? '');

const app = express();
app.use(express.json());
app.use(express.static('dist/client'));
app.use(express.static('public'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// sessionId -> vapiWsUrl, kept until client connects
const pendingSessions = new Map<string, string>();

interface StartCallBody {
  targetType?: string;
  targetId?: string;
  overrides?: Record<string, unknown>;
  name?: string;
  metadata?: Record<string, unknown>;
  sampleRate?: number;
}

app.post('/api/start-call', async (req, res) => {
  try {
    const url = `${API_URL}/call`;
    const body: StartCallBody = req.body ?? {};

    if (body.targetType !== undefined && !isTargetType(body.targetType)) {
      res.status(400).json({ error: `targetType must be one of: ${TARGET_TYPES.join(', ')}` });
      return;
    }

    // An id without a type means the caller wants the type they asked for, not
    // whatever the .env default happens to be — so the type only falls back
    // when the id does too, and only to a default of the same type. Falling
    // back across types would start an assistant call while the UI says Squad.
    const requestedType: TargetType = body.targetType ?? DEFAULT_TARGET?.type ?? 'assistant';
    const target: Target | null = body.targetId
      ? { type: requestedType, id: body.targetId }
      : DEFAULT_TARGET?.type === requestedType
        ? DEFAULT_TARGET
        : null;

    if (!target) {
      res.status(400).json({
        error: DEFAULT_TARGET
          ? `No ${requestedType} ID provided — VAPI_DEFAULT_TARGET is "${DEFAULT_TARGET.type}:${DEFAULT_TARGET.id}". Enter one in the ID field, or change the default in .env`
          : 'targetId is required — set VAPI_DEFAULT_TARGET in .env or pass it in the request body',
      });
      return;
    }

    if (body.sampleRate !== undefined && (typeof body.sampleRate !== 'number' || !Number.isFinite(body.sampleRate) || body.sampleRate < 3000 || body.sampleRate > 192000)) {
      res.status(400).json({ error: 'sampleRate must be a number between 3000 and 192000' });
      return;
    }
    const sampleRate = body.sampleRate !== undefined ? Math.round(body.sampleRate) : 44100;

    const callPayload: Record<string, unknown> = {
      [target.type === 'squad' ? 'squadId' : 'assistantId']: target.id,
      transport: {
        provider: 'vapi.websocket',
        audioFormat: {
          format: 'pcm_s16le',
          container: 'raw',
          sampleRate,
        },
      },
    };
    // `squadOverrides` applies to every member of the squad; `assistantOverrides`
    // is silently ignored on a squad call, so the key has to follow the type.
    if (body.overrides) {
      callPayload[target.type === 'squad' ? 'squadOverrides' : 'assistantOverrides'] = body.overrides;
    }
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
  res.json({ defaultTarget: DEFAULT_TARGET });
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
  console.log(`Default target: ${DEFAULT_TARGET ? `${DEFAULT_TARGET.type} ${DEFAULT_TARGET.id}` : '(none — set in UI or .env)'}`);
});
