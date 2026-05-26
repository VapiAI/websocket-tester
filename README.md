# Vapi WebSocket Tester

A webapp for testing [WebSocket transport] calls with Vapi. Includes
bidirectional audio streaming, a realtime event viewer, and [call control]
messages.

[WebSocket transport]: https://docs.vapi.ai/calls/websocket-transport
[call control]: https://docs.vapi.ai/calls/call-features

## Setup

Copy the `.env` example file:
```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

| Variable | Required | Description |
|---|---|---|
| `VAPI_API_KEY` | Yes | Your Vapi API private key |
| `VAPI_ASSISTANT_ID` | No | Default assistant ID (can also be set in the UI) |
| `VAPI_API_URL` | No | Defaults to `https://api.vapi.ai` |
| `PORT` | No | Defaults to `8000` |

Install dependencies:
```bash
npm install
```

## Running

Build and run:
```bash
npm run build
npm start
```

Run in dev mode (automatically reloads when the code changes):
```bash
npm run dev
```

Open <http://localhost:8000> in your browser to access.

## Usage

1. Enter an Assistant ID in the header (or leave blank if `VAPI_ASSISTANT_ID` is
   set in `.env`)
2. Click **Start Call** - the server creates a `vapi.websocket` call and proxies
   the WebSocket connection
3. Click the **microphone button** to start sending audio from your mic
4. Incoming audio from the assistant plays automatically
5. All events from Vapi appear in the **Event Log** - click any entry to expand
   the full JSON
6. Use the **Controls** panel to send messages:
   - **Say** - make the assistant speak a specific string
   - **Add Message** - inject a message into the conversation history
   - **Control** - mute/unmute the assistant or customer, trigger the first
     message
   - **Raw JSON** - send any arbitrary JSON message
   - **Manual Audio** - advanced audio control
7. Click **End Call** or send `{"type": "end-call"}` via Raw JSON to terminate

## Architecture

The Node server acts as a WebSocket proxy so the Vapi API key never reaches the
browser.

```
Browser <-> ws://localhost:8000/ws <-> Node server <-> wss://... <-> Vapi
        <- assistant audio (binary PCM)
        <- server events (JSON)
        -> customer audio (binary PCM)
        -> call control messages (JSON)
```

Audio format: PCM signed 16-bit little-endian, 16 kHz, mono.
