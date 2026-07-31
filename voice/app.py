import os
import asyncio
import aiohttp
from fastapi import FastAPI, WebSocket
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.frames.frames import TextFrame, TranscriptionFrame, StartFrame
from pipecat.transports.network.fastapi_websocket import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.services.deepgram import DeepgramSTTService
from pipecat.services.google import GeminiTTSService

# ── Config ───────────────────────────────────────────────────────
NODEJS_API_URL = os.getenv("NODEJS_API_URL")        # e.g. https://qantu-api.onrender.com
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")        # Same key you use for Gemini 3.6

app = FastAPI()


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
            # Call connected — start silence timer for "hello" greeting
            self.silence_task = asyncio.create_task(self._silence_timer())
            await self.push_frame(frame, direction)

        elif isinstance(frame, TranscriptionFrame):
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

            if reply:
                self.transcript.append({"role": "assistant", "content": reply})
                await self.push_frame(TextFrame(reply), direction)

        else:
            await self.push_frame(frame, direction)

    # ── Silence timer: if caller says nothing for 3s, trigger greeting ──
    async def _silence_timer(self):
        try:
            await asyncio.sleep(3.0)
            reply = await self._call_nodejs("")
            if reply:
                self.transcript.append({"role": "assistant", "content": reply})
                await self.push_frame(TextFrame(reply))
        except asyncio.CancelledError:
            pass

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
    await websocket.accept()

    # Twilio always sends a "start" event first with call metadata
    start_msg = await websocket.receive_json()
    if start_msg.get("event") != "start":
        await websocket.close()
        return

    stream_sid = start_msg["start"]["streamSid"]
    call_sid = start_msg["start"]["callSid"]
    from_number = start_msg["start"]["from"]
    to_number = start_msg["start"]["to"]

    # ── Pipecat pipeline setup ──────────────────────────────────────
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_out_enabled=True,
            add_wav_header=False,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),   # detects when the caller
            vad_audio_passthrough=True,         # starts speaking, this is
                                                  # what makes barge-in real
            serializer=TwilioFrameSerializer(stream_sid),
        ),
    )

    stt = DeepgramSTTService(api_key=DEEPGRAM_API_KEY)

    # Gemini TTS — pipecat-ai 1.4.0 API (Settings replaces old params/GeminiTTSSettings)
    tts = GeminiTTSService(
        api_key=GOOGLE_API_KEY,
        settings=GeminiTTSService.Settings(
            model="gemini-2.5-flash-tts",
            voice="Kore",  # Documented options: Kore, Charon, Puck, Zephyr
            prompt="Speak naturally in a calm, professional tone at standard speaking pace."
        )
    )

    bridge = NodeJSBridge(api_url=NODEJS_API_URL)
    bridge.meta = {
        "call_sid": call_sid,
        "from": from_number,
        "to": to_number,
    }

    pipeline = Pipeline([
        transport.input(),
        stt,
        bridge,
        tts,
        transport.output(),
    ])

    task = PipelineTask(pipeline, PipelineParams(allow_interruptions=True))
    runner = PipelineRunner()

    # ── Run pipeline, guarantee /voice/end on disconnect ─────────────
    try:
        await runner.run(task)
    finally:
        await bridge.call_end()
