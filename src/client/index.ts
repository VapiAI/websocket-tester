import type {
  LogDir, SilenceState, StatusClass, WavParseResult,
  AnyMessage, StartCallApiResponse,
  StatusUpdateMessage, SpeechUpdateMessage, TranscriptMessage,
  ModelOutputMessage, ConversationUpdateMessage,
  FunctionCallMessage, FunctionCallResultMessage, EndOfCallReportMessage,
  SayMessage, AddMessageMessage, ControlMessage, EndCallMessage, ProxyErrorMessage,
} from './types';

// ─── State ────────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let callId: string | null = null;
let audioCtx: AudioContext | null = null;
let currentSampleRate = 44100;
let nextPlayTime = 0;
let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let micNode: ScriptProcessorNode | null = null;
let micActive = false;
let autoScroll = true;
let expandedEntry: HTMLElement | null = null;

let rxBytesAccum = 0;
let txBytesAccum = 0;
let rxChunks = 0;

// ─── Stats ────────────────────────────────────────────────────────────────────

function fmtBitrate(bitsPerSec: number): string {
  if (bitsPerSec === 0) return '0 bps';
  if (bitsPerSec < 1000) return `${bitsPerSec} bps`;
  if (bitsPerSec < 1_000_000) return `${(bitsPerSec / 1000).toFixed(1)} kbps`;
  return `${(bitsPerSec / 1_000_000).toFixed(2)} Mbps`;
}

setInterval(() => {
  const rxEl = document.getElementById('stat-rx')!;
  const txEl = document.getElementById('stat-tx')!;
  const chunksEl = document.getElementById('stat-chunks')!;

  const rxBps = rxBytesAccum * 8;
  const txBps = txBytesAccum * 8;

  rxEl.textContent = fmtBitrate(rxBps);
  rxEl.className = 'stat-value' + (rxBps > 0 ? ' active' : '');
  txEl.textContent = fmtBitrate(txBps);
  txEl.className = 'stat-value' + (txBps > 0 ? ' active' : '');
  chunksEl.textContent = String(rxChunks);

  rxBytesAccum = 0;
  txBytesAccum = 0;
}, 1000);

// Minimum number of seconds to wait between uploading audio chunks. 20ms is the preferred value by Vapi
const audioChunkIntervalMs = 20;

function parseSelectedSampleRate(): number | null {
  const sel = document.getElementById('sample-rate') as HTMLSelectElement;
  if (sel.value !== 'custom') return parseInt(sel.value, 10);
  const val = parseInt((document.getElementById('sample-rate-custom') as HTMLInputElement).value, 10);
  return (Number.isFinite(val) && val >= 3000 && val <= 192000) ? val : null;
}

function onCustomRateInput(): void {
  const input = document.getElementById('sample-rate-custom') as HTMLInputElement;
  const valid = parseSelectedSampleRate() !== null;
  const hasValue = input.value !== '';
  input.classList.toggle('invalid', hasValue && !valid);
  document.getElementById('sample-rate-error')!.style.display = (hasValue && !valid) ? '' : 'none';
  (document.getElementById('btn-start') as HTMLButtonElement).disabled = !valid;
}

// Returns the smallest power-of-2 ScriptProcessorNode buffer size that yields a chunk >= audioChunkIntervalMs.
function bufferSizeForRate(sampleRate: number): number {
  const minSamples = sampleRate * audioChunkIntervalMs / 1000;
  const sizes = [256, 512, 1024, 2048, 4096, 8192, 16384];
  return sizes.find(s => s >= minSamples) ?? 16384;
}

// ─── Audio Utilities ──────────────────────────────────────────────────────────

function int16ToFloat32(buf: Int16Array): Float32Array {
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 32768.0;
  return out;
}

function float32ToInt16(buf: Float32Array): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function ensureAudioCtx(): void {
  if (!audioCtx || audioCtx.state === 'closed' || audioCtx.sampleRate !== currentSampleRate) {
    if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close();
    audioCtx = new AudioContext({ sampleRate: currentSampleRate });
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playAudioChunk(arrayBuffer: ArrayBuffer): void {
  ensureAudioCtx();
  const int16 = new Int16Array(arrayBuffer);
  if (int16.length === 0) return;
  const float32 = int16ToFloat32(int16);
  const buffer = audioCtx!.createBuffer(1, float32.length, currentSampleRate);
  buffer.getChannelData(0).set(float32);
  const source = audioCtx!.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx!.destination);
  const startAt = Math.max(audioCtx!.currentTime + 0.02, nextPlayTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;
}

// ─── Microphone ───────────────────────────────────────────────────────────────

function attachMicNodes(): void {
  if (micSource) { micSource.disconnect(); micSource = null; }
  if (micNode) { micNode.disconnect(); micNode = null; }

  micSource = audioCtx!.createMediaStreamSource(micStream!);

  // ScriptProcessor is deprecated but universally supported
  const micBufSize = bufferSizeForRate(currentSampleRate);
  console.log(
    "Attaching mic: sampleRate=%s, bufSize=%s, chunkInterval=%sms",
    currentSampleRate, micBufSize, micBufSize / currentSampleRate * 1000
  );

  micNode = audioCtx!.createScriptProcessor(micBufSize, 1, 1);
  const meter = document.getElementById('mic-meter')!;

  micNode.onaudioprocess = (e: AudioProcessingEvent) => {
    if (!micActive) return;
    const float32 = e.inputBuffer.getChannelData(0);

    let rms = 0;
    for (let i = 0; i < float32.length; i++) rms += float32[i] * float32[i];
    rms = Math.sqrt(rms / float32.length);
    meter.style.width = Math.min(100, rms * 800) + '%';

    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const int16 = float32ToInt16(float32);
    txBytesAccum += int16.byteLength;
    ws.send(int16.buffer);
  };

  micSource.connect(micNode);
  micNode.connect(audioCtx!.destination); // must be connected to run
}

async function startMic(): Promise<void> {
  ensureAudioCtx();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    logSys(`Mic error: ${(e as Error).message}`);
    return;
  }

  attachMicNodes();

  micActive = true;
  document.getElementById('btn-mic')!.classList.add('active');
  const micStatus = document.getElementById('mic-status')!;
  micStatus.textContent = 'Active';
  micStatus.className = 'mic-status active';
  if (silenceActive) setSilenceStatus('paused', 'Paused — mic active');
  logSys('Microphone started');
}

function stopMic(): void {
  micActive = false; // set first so any in-flight onaudioprocess callbacks bail immediately
  if (micSource) { micSource.disconnect(); micSource = null; }
  if (micNode) { micNode.disconnect(); micNode = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (silenceActive) {
    if (ws && ws.readyState === WebSocket.OPEN) setSilenceStatus('active', 'Sending');
    else setSilenceStatus('waiting', 'Waiting for call…');
  }
  document.getElementById('btn-mic')!.classList.remove('active');
  const micStatus = document.getElementById('mic-status')!;
  micStatus.textContent = 'Inactive';
  micStatus.className = 'mic-status inactive';
  document.getElementById('mic-meter')!.style.width = '0%';
  logSys('Microphone stopped');
}

async function toggleMic(): Promise<void> {
  if (micActive) stopMic(); else await startMic();
}

// ─── WebSocket / Call ─────────────────────────────────────────────────────────

async function startCall(): Promise<void> {
  const assistantId = (document.getElementById('assistant-id') as HTMLInputElement).value.trim();
  const sampleRate = parseSelectedSampleRate()!;
  setStatus('connecting', 'Connecting…');

  let data: StartCallApiResponse;
  try {
    const body: Record<string, unknown> = { sampleRate };
    if (assistantId) body.assistantId = assistantId;

    const rawOverrides = (document.getElementById('cfg-overrides') as HTMLTextAreaElement).value.trim();
    if (rawOverrides) {
      try {
        body.assistantOverrides = JSON.parse(rawOverrides) as unknown;
      } catch (e) {
        setStatus('error', 'Error');
        logSys(`assistantOverrides JSON parse error: ${(e as Error).message}`);
        return;
      }
    }

    const res = await fetch('/api/start-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    data = await res.json() as StartCallApiResponse;
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  } catch (e) {
    setStatus('error', `Error: ${(e as Error).message}`);
    logSys(`Call creation failed: ${(e as Error).message}`);
    return;
  }

  callId = data.callId;
  const prevSampleRate = currentSampleRate;
  currentSampleRate = sampleRate;
  updateSilenceConfig();
  if (micActive && micStream && sampleRate !== prevSampleRate) {
    ensureAudioCtx();
    attachMicNodes();
  }
  logSys(`Call created: ${callId} (${sampleRate} Hz)`);

  const wsUrl = `ws://${location.host}/ws?session=${data.sessionId}`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    logSys('WebSocket open (proxy connected)');
  });

  ws.addEventListener('message', async (event: MessageEvent<Blob | string>) => {
    if (event.data instanceof Blob) {
      const buf = await event.data.arrayBuffer();
      rxBytesAccum += buf.byteLength;
      rxChunks++;
      playAudioChunk(buf);
    } else if (typeof event.data === 'string') {
      let parsed: AnyMessage;
      try { parsed = JSON.parse(event.data) as AnyMessage; } catch { logSys(`Non-JSON: ${event.data}`); return; }
      handleServerEvent(parsed);
    }
  });

  ws.addEventListener('close', (e: CloseEvent) => {
    logSys(`WebSocket closed: code=${e.code} reason=${e.reason || '(none)'}`);
    setStatus('', 'Disconnected');
    setConnected(false);
    nextPlayTime = 0;
    rxBytesAccum = 0; txBytesAccum = 0;
    (['stat-rx', 'stat-tx'] as const).forEach(id => {
      const el = document.getElementById(id)!;
      el.textContent = '—';
      el.className = 'stat-value';
    });
  });

  ws.addEventListener('error', () => {
    logSys('WebSocket error');
    setStatus('error', 'Error');
  });

  setConnected(true);
}

function endCall(): void {
  const msg: EndCallMessage = { type: 'end-call' };
  sendJSON(msg);
  logOut(msg);
}

function handleServerEvent(msg: AnyMessage): void {
  const type = msg.type;

  if (type === 'proxy.connected') {
    setStatus('connected', 'Connected');
    logSys('Proxy connected — session active');
    return;
  }

  if (type === 'proxy.error') {
    const err = msg as ProxyErrorMessage;
    logSys(`Proxy error: ${err.message}`);
    setStatus('error', 'Proxy Error');
    return;
  }

  if (type === 'status-update') {
    const su = msg as StatusUpdateMessage;
    setStatus(su.status === 'ended' ? '' : 'active', su.status);
    if (su.status === 'ended') setConnected(false);
  }

  logIn(msg);
}

// ─── Control Messages ─────────────────────────────────────────────────────────

function sendJSON(obj: AnyMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) { logSys('Not connected'); return; }
  ws.send(JSON.stringify(obj));
}

function sendSay(): void {
  const content = (document.getElementById('say-content') as HTMLTextAreaElement).value.trim();
  if (!content) return;
  const msg: SayMessage = {
    type: 'say',
    content,
    endCallAfterSpoken: (document.getElementById('say-end-call') as HTMLInputElement).checked,
    interruptAssistantEnabled: (document.getElementById('say-interrupt') as HTMLInputElement).checked,
  };
  sendJSON(msg);
  logOut(msg);
}

function sendAddMessage(): void {
  const content = (document.getElementById('add-msg-content') as HTMLTextAreaElement).value.trim();
  if (!content) return;
  const msg: AddMessageMessage = {
    type: 'add-message',
    message: {
      role: (document.getElementById('add-msg-role') as HTMLSelectElement).value,
      content,
    },
    triggerResponseEnabled: (document.getElementById('add-msg-trigger') as HTMLInputElement).checked,
  };
  sendJSON(msg);
  logOut(msg);
}

function sendControl(): void {
  const msg: ControlMessage = {
    type: 'control',
    control: (document.getElementById('control-action') as HTMLSelectElement).value,
  };
  sendJSON(msg);
  logOut(msg);
}

function sendRaw(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) { logSys('Not connected'); return; }
  const raw = (document.getElementById('raw-json') as HTMLTextAreaElement).value.trim();
  if (!raw) return;
  let parsed: AnyMessage;
  try { parsed = JSON.parse(raw) as AnyMessage; } catch (e) { logSys(`Invalid JSON: ${(e as Error).message}`); return; }
  sendJSON(parsed);
  logOut(parsed);
}

// ─── Silence Stream ───────────────────────────────────────────────────────────

let silenceActive = false;
let silenceInterval: ReturnType<typeof setInterval> | null = null;
let silenceFrame = new ArrayBuffer(Math.round(currentSampleRate * audioChunkIntervalMs / 1000) * 2);

function updateSilenceConfig(): void {
  silenceFrame = new ArrayBuffer(Math.round(currentSampleRate * audioChunkIntervalMs / 1000) * 2);
}

function toggleSilence(): void {
  silenceActive ? stopSilence() : startSilence();
}

function startSilence(): void {
  silenceActive = true;
  document.getElementById('btn-silence')!.textContent = 'Stop';
  logSys('Silence stream started');

  silenceInterval = setInterval(() => {
    if (!silenceActive) return;
    if (micActive) {
      setSilenceStatus('paused', 'Paused — mic active');
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setSilenceStatus('waiting', 'Waiting for call…');
      return;
    }
    ws.send(silenceFrame);
    txBytesAccum += silenceFrame.byteLength;
    setSilenceStatus('active', 'Sending');
  }, audioChunkIntervalMs);
}

function stopSilence(): void {
  silenceActive = false;
  if (silenceInterval) { clearInterval(silenceInterval); silenceInterval = null; }
  document.getElementById('btn-silence')!.textContent = 'Start';
  setSilenceStatus('off', 'Off');
  logSys('Silence stream stopped');
}

function setSilenceStatus(state: SilenceState, label: string): void {
  const el = document.getElementById('silence-status')!;
  el.textContent = label;
  el.style.color = state === 'active' ? 'var(--green)' : state === 'paused' ? 'var(--yellow)' : 'var(--muted)';
}

// ─── Manual Audio ─────────────────────────────────────────────────────────────

let wavPcmBuffer: ArrayBuffer | null = null;

function parseWav(arrayBuffer: ArrayBuffer): WavParseResult {
  const view = new DataView(arrayBuffer);
  const readStr = (off: number, len: number): string =>
    Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(off + i))).join('');

  if (readStr(0, 4) !== 'RIFF') return { ok: false, error: 'Not a RIFF file' };
  if (readStr(8, 4) !== 'WAVE') return { ok: false, error: 'Not a WAVE file' };

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataOffset = -1;
  let dataSize = -1;
  let offset = 12;

  while (offset + 8 <= arrayBuffer.byteLength) {
    const chunkId = readStr(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      audioFormat   = view.getUint16(offset + 8,  true);
      channels      = view.getUint16(offset + 10, true);
      sampleRate    = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize   = chunkSize;
      break;
    }

    offset += 8 + chunkSize + (chunkSize % 2); // word-align
  }

  if (dataOffset === -1) return { ok: false, error: 'No data chunk found' };
  if (audioFormat === undefined || channels === undefined || sampleRate === undefined || bitsPerSample === undefined) {
    return { ok: false, error: 'No fmt chunk found' };
  }
  if (audioFormat !== 1) return { ok: false, error: `Unsupported audio format ${audioFormat} (only PCM=1 supported)` };

  return {
    ok: true,
    pcmData: arrayBuffer.slice(dataOffset, dataOffset + dataSize),
    channels,
    sampleRate,
    bitsPerSample,
  };
}

function handleWavChange(input: HTMLInputElement): void {
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e: ProgressEvent<FileReader>) => {
    const raw = e.target?.result;
    if (!(raw instanceof ArrayBuffer)) return;

    const result = parseWav(raw);
    if (!result.ok) {
      logSys(`WAV parse error: ${result.error}`);
      wavPcmBuffer = null;
      document.getElementById('wav-info')!.style.display = 'none';
      (document.getElementById('btn-wav') as HTMLButtonElement).disabled = true;
      return;
    }

    wavPcmBuffer = result.pcmData;

    const expectedRate = parseSelectedSampleRate() ?? currentSampleRate;
    const match = result.sampleRate === expectedRate && result.channels === 1 && result.bitsPerSample === 16;
    const kb = (wavPcmBuffer.byteLength / 1024).toFixed(1);
    const infoEl = document.getElementById('wav-info')!;
    infoEl.textContent =
      `${result.sampleRate} Hz · ${result.channels}ch · ${result.bitsPerSample}-bit · ${kb} KB PCM` +
      (match ? '' : `  ⚠ expected ${expectedRate} Hz / 1ch / 16-bit`);
    infoEl.className = 'wav-info' + (match ? '' : ' mismatch');
    infoEl.style.display = 'block';

    document.getElementById('wav-filename')!.textContent = file.name;
    if (ws && ws.readyState === WebSocket.OPEN) {
      (document.getElementById('btn-wav') as HTMLButtonElement).disabled = false;
    }

    logSys(`WAV loaded: ${file.name} — ${result.sampleRate} Hz, ${result.channels}ch, ${result.bitsPerSample}-bit, ${kb} KB`);
  };
  reader.readAsArrayBuffer(file);
}

function sendWav(): void {
  if (!wavPcmBuffer || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(wavPcmBuffer);
  txBytesAccum += wavPcmBuffer.byteLength;
  logSys(`Sent WAV: ${wavPcmBuffer.byteLength} bytes`);
}

function sendHex(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) { logSys('Not connected'); return; }
  const raw = (document.getElementById('hex-input') as HTMLTextAreaElement).value.trim();
  if (!raw) return;

  const clean = raw.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) { logSys('Hex error: odd number of nibbles'); return; }
  if (!/^[0-9a-fA-F]+$/.test(clean)) { logSys('Hex error: invalid characters'); return; }

  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }

  ws.send(bytes.buffer);
  txBytesAccum += bytes.byteLength;
  logSys(`Sent hex: ${bytes.byteLength} bytes`);
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function toggleOverrides(): void {
  const wrap = document.getElementById('overrides-wrap')!;
  const btn = document.getElementById('btn-overrides-toggle')!;
  const opening = !wrap.classList.contains('open');
  btn.textContent = opening ? 'Assistant overrides ▴' : 'Assistant overrides ▾';
  if (opening) {
    wrap.style.display = 'grid';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wrap.classList.add('open');
      (document.getElementById('cfg-overrides') as HTMLTextAreaElement).focus();
    }));
  } else {
    wrap.classList.remove('open');
    wrap.addEventListener('transitionend', () => {
      if (!wrap.classList.contains('open')) wrap.style.display = 'none';
    }, { once: true });
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function appendLog(dir: LogDir, tagHtml: string, summary: string, detail: string | null): void {
  const now = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const localTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  const log = document.getElementById('event-log')!;
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `
    <span class="log-time" title="${now.toISOString()}">${localTime}</span>
    <span class="log-dir ${dir}">${dir === 'in' ? '←' : dir === 'out' ? '→' : '·'}</span>
    ${tagHtml}
    <span class="log-summary-wrap">
      <span class="log-summary">${escHtml(summary)}</span>
      ${detail ? '<span class="log-expand">▾</span>' : ''}
    </span>
  `;
  entry.appendChild(row);

  if (detail) {
    const wrap = document.createElement('div');
    wrap.className = 'log-body-wrap';
    const body = document.createElement('div');
    body.className = 'log-body';
    body.textContent = detail;
    wrap.appendChild(body);
    entry.appendChild(wrap);
    entry.style.cursor = 'pointer';
    entry.onclick = () => {
      const isExpanded = entry.classList.contains('expanded');
      if (expandedEntry && expandedEntry !== entry) {
        expandedEntry.classList.remove('expanded');
      }
      entry.classList.toggle('expanded', !isExpanded);
      expandedEntry = isExpanded ? null : entry;
    };
  }

  log.appendChild(entry);
  if (autoScroll) log.scrollTop = log.scrollHeight;
}

function logIn(msg: AnyMessage): void {
  const type = msg.type ?? '?';
  const info = summarize(msg);
  appendLog('in', '<span class="log-tag tag-json">JSON</span>', info ? `${type}: ${info}` : type, JSON.stringify(msg, null, 2));
}

function logOut(msg: AnyMessage): void {
  const info = summarize(msg);
  appendLog('out', '<span class="log-tag tag-out">SEND</span>', info ? `${msg.type}: ${info}` : msg.type, JSON.stringify(msg, null, 2));
}

function logSys(text: string): void {
  appendLog('sys', '<span class="log-tag tag-sys">SYS</span>', text, null);
}

function clearLog(): void {
  document.getElementById('event-log')!.innerHTML = '';
  expandedEntry = null;
  rxChunks = 0;
  document.getElementById('stat-chunks')!.textContent = '0';
}

function toggleAutoScroll(): void {
  autoScroll = !autoScroll;
  const btn = document.getElementById('btn-autoscroll')!;
  btn.style.color = autoScroll ? 'var(--green)' : 'var(--muted)';
  btn.style.borderColor = autoScroll ? 'var(--green)' : 'var(--border)';
}

function summarize(msg: AnyMessage): string {
  const clip = (s: unknown, n = 60): string => String(s ?? '').slice(0, n);
  switch (msg.type) {
    case 'status-update': {
      const m = msg as StatusUpdateMessage;
      const parts = [m.status];
      if (m.endedReason) parts.push(`reason: ${m.endedReason}`);
      return parts.filter(Boolean).join(' · ');
    }
    case 'speech-update': {
      const m = msg as SpeechUpdateMessage;
      const parts = [m.status];
      if (m.role) parts.push(m.role);
      return parts.filter(Boolean).join(' · ');
    }
    case 'transcript': {
      const m = msg as TranscriptMessage;
      const metaParts: string[] = [];
      if (m.role) metaParts.push(m.role);
      if (m.transcriptType) metaParts.push(m.transcriptType);
      return `[${metaParts.join(' · ')}] ${clip(m.transcript, 60)}`;
    }
    case 'model-output': {
      const m = msg as ModelOutputMessage;
      return clip(m.output ?? m.modelOutput);
    }
    case 'conversation-update': {
      const m = msg as ConversationUpdateMessage;
      return `${(m.conversation ?? []).length} messages`;
    }
    case 'function-call': {
      const m = msg as FunctionCallMessage;
      return m.functionCall?.name ?? m.name ?? '';
    }
    case 'function-call-result': {
      const m = msg as FunctionCallResultMessage;
      return m.functionCallResult?.name ?? m.name ?? '';
    }
    case 'end-of-call-report': {
      const m = msg as EndOfCallReportMessage;
      const parts: string[] = [];
      if (m.durationSeconds != null) parts.push(`${Math.round(m.durationSeconds)}s`);
      if (m.endedReason) parts.push(m.endedReason);
      return parts.join(' · ');
    }
    case 'say': {
      const m = msg as SayMessage;
      return clip(m.content);
    }
    case 'add-message': {
      const m = msg as AddMessageMessage;
      return `[${m.message?.role}] ${clip(m.message?.content, 40)}`;
    }
    case 'control': {
      const m = msg as ControlMessage;
      return m.control ?? '';
    }
    // these types have no useful single-line summary
    case 'assistant-started':
    case 'workflow-node-started':
    case 'hang':
    default:
      return '';
  }
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── UI State ─────────────────────────────────────────────────────────────────

function setStatus(cls: StatusClass, text: string): void {
  const pill = document.getElementById('status-pill')!;
  pill.className = 'status-pill' + (cls ? ` ${cls}` : '');
  document.getElementById('status-text')!.textContent = text;
}

function setConnected(connected: boolean): void {
  const disable = (id: string, value: boolean): void => {
    (document.getElementById(id) as HTMLButtonElement).disabled = value;
  };
  disable('btn-start', connected || parseSelectedSampleRate() === null);
  disable('btn-end', !connected);
  disable('btn-say', !connected);
  disable('btn-add-msg', !connected);
  disable('btn-control', !connected);
  disable('btn-raw', !connected);
  disable('btn-wav', !connected || !wavPcmBuffer);
  disable('btn-hex', !connected);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.getElementById('btn-overrides-toggle')!.addEventListener('click', toggleOverrides);
document.getElementById('btn-start')!.addEventListener('click', startCall);
document.getElementById('btn-end')!.addEventListener('click', endCall);
document.getElementById('btn-clear-log')!.addEventListener('click', clearLog);
document.getElementById('btn-autoscroll')!.addEventListener('click', toggleAutoScroll);
document.getElementById('btn-mic')!.addEventListener('click', toggleMic);
document.getElementById('btn-say')!.addEventListener('click', sendSay);
document.getElementById('btn-add-msg')!.addEventListener('click', sendAddMessage);
document.getElementById('btn-control')!.addEventListener('click', sendControl);
document.getElementById('btn-raw')!.addEventListener('click', sendRaw);
document.getElementById('wav-file')!.addEventListener('change', e => handleWavChange(e.target as HTMLInputElement));
document.getElementById('btn-wav')!.addEventListener('click', sendWav);
document.getElementById('btn-hex')!.addEventListener('click', sendHex);
document.getElementById('btn-silence')!.addEventListener('click', toggleSilence);
document.getElementById('sample-rate')!.addEventListener('change', (e) => {
  const isCustom = (e.target as HTMLSelectElement).value === 'custom';
  const customInput = document.getElementById('sample-rate-custom') as HTMLInputElement;
  customInput.style.display = isCustom ? '' : 'none';
  if (isCustom) {
    customInput.focus();
    onCustomRateInput();
  } else {
    customInput.classList.remove('invalid');
    document.getElementById('sample-rate-error')!.style.display = 'none';
    (document.getElementById('btn-start') as HTMLButtonElement).disabled = false;
  }
});
document.getElementById('sample-rate-custom')!.addEventListener('input', onCustomRateInput);

// Sync custom input visibility in case the browser restored the dropdown to 'custom' after a refresh
if ((document.getElementById('sample-rate') as HTMLSelectElement).value === 'custom') {
  (document.getElementById('sample-rate-custom') as HTMLInputElement).style.display = '';
  onCustomRateInput();
}

(async () => {
  try {
    const cfg = await fetch('/api/config').then(r => r.json()) as { defaultAssistantId?: string };
    if (cfg.defaultAssistantId) {
      (document.getElementById('assistant-id') as HTMLInputElement).placeholder =
        `Assistant ID (default: ${cfg.defaultAssistantId})`;
    }
  } catch {}
  logSys('Ready — click "Start Call" to begin');
})();
