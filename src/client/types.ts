export type LogDir = 'in' | 'out' | 'sys';
export type SilenceState = 'active' | 'paused' | 'waiting' | 'off';
export type StatusClass = 'connecting' | 'connected' | 'active' | 'error' | '';

export interface WavParseSuccess {
  ok: true;
  pcmData: ArrayBuffer;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export interface WavParseError {
  ok: false;
  error: string;
}

export type WavParseResult = WavParseSuccess | WavParseError;

// Base type for all messages — specific interfaces extend this for typed access
export type AnyMessage = { type: string } & Record<string, unknown>;

export interface StatusUpdateMessage extends AnyMessage {
  type: 'status-update';
  status: string;
  endedReason?: string;
}

export interface SpeechUpdateMessage extends AnyMessage {
  type: 'speech-update';
  status: string;
  role?: string;
}

export interface TranscriptMessage extends AnyMessage {
  type: 'transcript';
  role?: string;
  transcriptType?: string
  transcript?: string;
}

export interface ModelOutputMessage extends AnyMessage {
  type: 'model-output';
  output?: string;
  modelOutput?: string;
}

export interface ConversationUpdateMessage extends AnyMessage {
  type: 'conversation-update';
  conversation?: unknown[];
}

export interface FunctionCallMessage extends AnyMessage {
  type: 'function-call';
  functionCall?: { name: string };
  name?: string;
}

export interface FunctionCallResultMessage extends AnyMessage {
  type: 'function-call-result';
  functionCallResult?: { name: string };
  name?: string;
}

export interface EndOfCallReportMessage extends AnyMessage {
  type: 'end-of-call-report';
  durationSeconds?: number;
  endedReason?: string;
}

export interface SayMessage extends AnyMessage {
  type: 'say';
  content: string;
  endCallAfterSpoken: boolean;
  interruptAssistantEnabled: boolean;
}

export interface AddMessageMessage extends AnyMessage {
  type: 'add-message';
  message?: { role: string; content: string };
  triggerResponseEnabled: boolean;
}

export interface ControlMessage extends AnyMessage {
  type: 'control';
  control: string;
}

export interface EndCallMessage extends AnyMessage {
  type: 'end-call';
}

export interface ProxyConnectedMessage extends AnyMessage {
  type: 'proxy.connected';
  sessionId?: string;
}

export interface ProxyErrorMessage extends AnyMessage {
  type: 'proxy.error';
  message: string;
}

export interface StartCallApiResponse {
  callId: string;
  sessionId: string;
  status: string;
  error?: string;
}
