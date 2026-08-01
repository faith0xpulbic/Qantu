import os
import asyncio
import aiohttp
from fastapi import FastAPI, WebSocket, Request, Response
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.frames.frames import TextFrame, TranscriptionFrame, StartFrame, ErrorFrame, TTSAudioRawFrame
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.google.tts import GeminiTTSService

# ── Config ───────────────────────────────────────────────────────
NODEJS_API_URL = os.getenv("NODEJS_API_URL")        # e.g. https://qantu-api.onrender.com
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")  # accept either name
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")  # from Twilio Console dashboard
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")    # from Twilio Console dashboard

# GeminiTTSService (Google Cloud TTS backend) has NO api_key support — it
# requires a real GCP service account. Render "Secret Files" mounts uploaded
# files at /etc/secrets/<filename>. Override with GOOGLE_CREDENTIALS_PATH
# env var if you name the secret file something else.
GOOGLE_CREDENTIALS_PATH = os.getenv("GOOGLE_CREDENTIALS_PATH", "/etc/secrets/google-credentials.json")

for _name, _val in [("NODEJS_API_URL", NODEJS_API_URL), ("DEEPGRAM_API_KEY", DEEPGRAM_API_KEY), ("GOOGLE_API_KEY / GEMINI_API_KEY", GOOGLE_API_KEY), ("TWILIO_ACCOUNT_SID", TWILIO_ACCOUNT_SID), ("TWILIO_AUTH_TOKEN", TWILIO_AUTH_TOKEN)]:
    if not _val:
        print(f"[startup] WARNING: env var {_name} is not set")

if not os.path.exists(GOOGLE_CREDENTIALS_PATH):
    print(f"[startup] WARNING: GCP service account file not found at {GOOGLE_CREDENTIALS_PATH}")

app = FastAPI()
print("[startup] app.py version: connected-event-fix-v2")


@app.on_event("startup")
async def verify_google_credentials_file():
    """Sanity-check the GCP service account file GeminiTTSService will
    actually use — confirms it exists, parses as JSON, and has the fields
    a service account key needs, before any call tries to use it."""
    if not os.path.exists(GOOGLE_CREDENTIALS_PATH):
        print(f"[startup] GCP credentials file MISSING at {GOOGLE_CREDENTIALS_PATH}", flush=True)
        return
    try:
        import json as _json
        with open(GOOGLE_CREDENTIALS_PATH) as f:
            data = _json.load(f)
        required = ["type", "project_id", "private_key", "client_email"]
        missing = [k for k in required if k not in data]
        if missing:
            print(f"[startup] GCP credentials file parsed but missing fields: {missing}", flush=True)
        else:
            print(f"[startup] GCP credentials file OK — project_id={data.get('project_id')}, client_email={data.get('client_email')}", flush=True)
    except Exception as e:
        print(f"[startup] GCP credentials file failed to parse: {e}", flush=True)


@app.on_event("startup")
async def verify_google_key():
    """Quick standalone check: is GOOGLE_API_KEY actually valid against
    Google's API? Runs independent of Pipecat/pipeline construction so we
    can tell 'bad key' apart from 'bad model name' without a live call."""
    if not GOOGLE_API_KEY:
        return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": GOOGLE_API_KEY},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    names = [m.get("name", "") for m in data.get("models", [])]
                    tts_models = [n for n in names if "tts" in n.lower()]
                    print(f"[startup] GOOGLE_API_KEY is VALID. {len(names)} models visible. TTS models: {tts_models}", flush=True)
                else:
                    body = await resp.text()
                    print(f"[startup] GOOGLE_API_KEY check FAILED — HTTP {resp.status}: {body[:300]}", flush=True)
    except Exception as e:
        print(f"[startup] GOOGLE_API_KEY check errored: {e}", flush=True)


@app.on_event("startup")
async def verify_deepgram_key():
    """Hit Deepgram's actual transcription endpoint with a tiny public sample
    URL — this only needs the same usage:write permission a real STT
    connection needs, unlike /v1/auth/grant which requires Member+ scope
    and can 403 even on a perfectly usable transcription key."""
    if not DEEPGRAM_API_KEY:
        return
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.deepgram.com/v1/listen",
                headers={
                    "Authorization": f"Token {DEEPGRAM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={"url": "https://dpgr.am/spacewalk.wav"},
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                body = await resp.text()
                if resp.status == 200:
                    print(f"[startup] DEEPGRAM_API_KEY is VALID (transcription succeeded).", flush=True)
                else:
                    print(f"[startup] DEEPGRAM_API_KEY check FAILED — HTTP {resp.status}: {body[:300]}", flush=True)
    except Exception as e:
        print(f"[startup] DEEPGRAM_API_KEY check errored: {e}", flush=True)


@app.post("/voice")
async def voice_webhook(request: Request):
    """
    Twilio's 'A call comes in' webhook. Returns TwiML instructing Twilio
    to open a Media Stream to our /ws websocket endpoint.

    Twilio's Media Streams 'start' event does NOT include From/To natively
    (confirmed against Twilio docs) — so we pass them through explicitly as
    <Parameter> tags, which Twilio delivers back inside start.customParameters.
    """
    form = await request.form()
    from_number = form.get("From", "")
    to_number = form.get("To", "")
    call_sid = form.get("CallSid", "")

    host = request.url.hostname  # e.g. qantu-1.onrender.com
    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://{host}/ws">
            <Parameter name="From" value="{from_number}" />
            <Parameter name="To" value="{to_number}" />
            <Parameter name="CallSid" value="{call_sid}" />
        </Stream>
    </Connect>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


class DebugTap(FrameProcessor):
    """Logs every frame passing through — specifically catches ErrorFrame
    (which GeminiTTSService yields on failure instead of raising, so our
    try/except around construction never sees it) and counts audio frames
    to confirm whether TTS is actually producing output."""

    def __init__(self, label: str):
        super().__init__()
        self.label = label
        self.audio_frame_count = 0

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, ErrorFrame):
            print(f"[{self.label}] ErrorFrame: {frame.error}", flush=True)
        elif isinstance(frame, TTSAudioRawFrame):
            self.audio_frame_count += 1
            if self.audio_frame_count == 1:
                print(f"[{self.label}] First TTSAudioRawFrame received — audio IS being generated", flush=True)
        elif isinstance(frame, TextFrame):
            print(f"[{self.label}] TextFrame: {frame.text!r}", flush=True)
        await self.push_frame(frame, direction)


class NodeJSBridge(FrameProcessor):
    """
    Catches STT transcriptions, maintains the full in-memory transcript,
    calls Node.js /voice/process for Gemini 3.6 reasoning, and pushes
    the reply text into the Gemini 3.1 TTS pipeline.
    """

    def __init__(self, api_url: str):
        super().__init__()
        self.api_url = api_url
        self.transcript = []          # Pipecat's in-memory call log
        self.meta = {}                # call_sid, from, to, conversation_id, etc.
        self.silence_task = None      # asyncio task for the 3s greeting timer

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            print("[bridge] StartFrame received, starting 3s silence timer", flush=True)
            self.silence_task = asyncio.create_task(self._silence_timer())
            await self.push_frame(frame, direction)

        elif isinstance(frame, TranscriptionFrame):
            print(f"[bridge] TranscriptionFrame received: {frame.text!r}", flush=True)
            # Cancel silence timer — caller spoke before timeout
            if self.silence_task:
                self.silence_task.cancel()
                try:
                    await self.silence_task
                except asyncio.CancelledError:
                    pass
                self.silence_task = None

            text = frame.text.strip()
            if not text:
                await self.push_frame(frame, direction)
                return

            # Log caller turn and hit Node.js
            self.transcript.append({"role": "customer", "content": text})
            reply = await self._call_nodejs(text)
            print(f"[bridge] Node.js reply for user text: {reply!r}", flush=True)

            if reply:
                self.transcript.append({"role": "assistant", "content": reply})
                await self.push_frame(TextFrame(reply), direction)
                print("[bridge] Pushed TextFrame with reply downstream to TTS", flush=True)
            else:
                print("[bridge] No reply from Node.js — nothing pushed to TTS", flush=True)

        else:
            await self.push_frame(frame, direction)

    # ── Silence timer: if caller says nothing for 3s, trigger greeting ──
    async def _silence_timer(self):
        try:
            print("[bridge] Silence timer running — waiting 3s before greeting", flush=True)
            await asyncio.sleep(3.0)
            print("[bridge] Silence timer elapsed — calling Node.js for greeting", flush=True)
            reply = await self._call_nodejs("")
            print(f"[bridge] Node.js greeting reply: {reply!r}", flush=True)
            if reply:
                self.transcript.append({"role": "assistant", "content": reply})
                await self.push_frame(TextFrame(reply))
                print("[bridge] Pushed greeting TextFrame downstream to TTS", flush=True)
            else:
                print("[bridge] No greeting reply from Node.js — nothing pushed to TTS", flush=True)
        except asyncio.CancelledError:
            print("[bridge] Silence timer cancelled (caller spoke first)", flush=True)

    # ── POST to Node.js /voice/process ────────────────────────────────
    async def _call_nodejs(self, text: str):
        payload = {
            "callSid": self.meta.get("call_sid"),
            "from": self.meta.get("from"),
            "to": self.meta.get("to"),
            "text": text,
            "transcript": self.transcript,
            "conversationId": self.meta.get("conversation_id"),
            "businessId": self.meta.get("business_id"),
            "customerId": self.meta.get("customer_id"),
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.api_url}/voice/process",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        # Cache IDs for subsequent turns
                        self.meta["conversation_id"] = data.get("conversationId") or self.meta.get("conversation_id")
                        self.meta["business_id"] = data.get("businessId") or self.meta.get("business_id")
                        self.meta["customer_id"] = data.get("customerId") or self.meta.get("customer_id")
                        return data.get("reply")
                    else:
                        print(f"Node.js returned {resp.status}")
                        return "Sorry, I'm having trouble right now."
        except Exception as e:
            print(f"Error calling Node.js /voice/process: {e}")
            return "Sorry, I'm having trouble right now."

    # ── POST to Node.js /voice/end ────────────────────────────────────
    async def call_end(self):
        payload = {
            "callSid": self.meta.get("call_sid"),
            "transcript": self.transcript,
            "conversationId": self.meta.get("conversation_id"),
        }
        try:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{self.api_url}/voice/end",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=30),
                )
        except Exception as e:
            print(f"Error calling Node.js /voice/end: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    import json
    import traceback

    print("[ws] Handler entered, accepting connection...", flush=True)
    await websocket.accept()
    print("[ws] Connection accepted, waiting for first message...", flush=True)

    # Twilio sends a "connected" event first (handshake ack, no metadata),
    # THEN a "start" event with the actual call metadata we need.
    # Docs: https://www.twilio.com/docs/voice/media-streams/websocket-messages
    start_msg = None
    try:
        for i in range(5):  # small bound so a malformed stream can't hang forever
            raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
            print(f"[ws] Raw message #{i}: {raw[:500]}", flush=True)
            msg = json.loads(raw)
            event = msg.get("event")
            if event == "connected":
                print("[ws] Received 'connected' handshake event, waiting for 'start'...", flush=True)
                continue
            if event == "start":
                start_msg = msg
                break
            print(f"[ws] Unexpected event before 'start': {event}", flush=True)
    except Exception as e:
        print(f"[ws] Failed to receive/parse start event: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        await websocket.close()
        return

    if start_msg is None:
        print("[ws] Never received a 'start' event", flush=True)
        await websocket.close()
        return

    try:
        stream_sid = start_msg["start"]["streamSid"]
        call_sid = start_msg["start"]["callSid"]
        custom_params = start_msg["start"].get("customParameters", {})
        from_number = custom_params.get("From", "")
        to_number = custom_params.get("To", "")
    except KeyError as e:
        print(f"[ws] start event missing expected field: {e}. Payload: {start_msg}", flush=True)
        await websocket.close()
        return

    print(f"[ws] Call started — call_sid={call_sid} from={from_number} to={to_number}", flush=True)



    # ── Pipecat pipeline setup ──────────────────────────────────────
    try:
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_out_enabled=True,
                add_wav_header=False,
                vad_enabled=True,
                vad_analyzer=SileroVADAnalyzer(),   # detects when the caller
                vad_audio_passthrough=True,         # starts speaking, this is
                                                      # what makes barge-in real
                serializer=TwilioFrameSerializer(
                    stream_sid=stream_sid,
                    call_sid=call_sid,
                    account_sid=TWILIO_ACCOUNT_SID,
                    auth_token=TWILIO_AUTH_TOKEN,
                ),
            ),
        )
    except Exception as e:
        print(f"[ws] TRANSPORT construction failed for call_sid={call_sid}: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        await websocket.close()
        return

    try:
        stt = DeepgramSTTService(api_key=DEEPGRAM_API_KEY)
    except Exception as e:
        print(f"[ws] DEEPGRAM STT construction failed for call_sid={call_sid}: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        await websocket.close()
        return

    # CONFIRMED against live pipecat-ai 1.4.0 source (services/google/tts.py):
    # GeminiTTSService has NO api_key parameter — it requires a real GCP
    # service account via credentials_path (or credentials as a JSON string).
    # GOOGLE_CREDENTIALS_PATH points at a Render Secret File mount.
    try:
        tts = GeminiTTSService(
            credentials_path=GOOGLE_CREDENTIALS_PATH,
            location="us-central1",  # error showed locations/global — Vertex AI preview
                                       # models often require a specific region instead
            settings=GeminiTTSService.Settings(
                model="gemini-3.1-flash-tts-preview",
                voice="Aoede",  # One of 30 valid voices (GeminiTTSService.AVAILABLE_VOICES)
                prompt="Speak naturally in a calm, professional tone at standard speaking pace."
            )
        )
    except Exception as e:
        print(f"[ws] GEMINI TTS construction failed for call_sid={call_sid}: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        await websocket.close()
        return

    try:
        bridge = NodeJSBridge(api_url=NODEJS_API_URL)
        bridge.meta = {
            "call_sid": call_sid,
            "from": from_number,
            "to": to_number,
        }

        debug_tap = DebugTap("tts-out")

        pipeline = Pipeline([
            transport.input(),
            stt,
            bridge,
            tts,
            debug_tap,
            transport.output(),
        ])

        task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
        runner = PipelineRunner()
    except Exception as e:
        print(f"[ws] PIPELINE ASSEMBLY failed for call_sid={call_sid}: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        await websocket.close()
        return

    # ── Run pipeline, guarantee /voice/end on disconnect ─────────────
    try:
        await runner.run(task)
    except Exception as e:
        print(f"[ws] Pipeline run failed for call_sid={call_sid}: {e}", flush=True)
    finally:
        await bridge.call_end()
