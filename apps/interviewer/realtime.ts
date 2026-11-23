import type { Locale } from '../../packages/i18n/locales.ts';
import { voiceLanguageChange } from './facts.ts';
import type { SessionUpdate, VoiceContext } from './voice.ts';
import { sessionUpdate, voiceTools } from './voice.ts';

/**
 * One live voice conversation with the Realtime service, whatever shows it: the interview page and
 * the card embedded in a chat run the same call. It owns the WebRTC peer, the data-channel protocol
 * and the turn-taking; it touches no DOM. What is on screen is told through the hooks, and the
 * browser itself (microphone, peer connection, `fetch`) is injectable, so
 * `tests/interviewer-card.test.ts` runs a whole conversation against fakes.
 *
 * The OpenAI key never reaches this code: the SDP offer is posted to ReloCat's own `/interview/voice`,
 * which answers with the service's SDP answer.
 */

/** Events sent to the Realtime session over the data channel. */
type RealtimeClientEvent =
  | { type: 'response.create' }
  | SessionUpdate
  | {
      type: 'conversation.item.create';
      item:
        | { type: 'message'; role: 'system' | 'user'; content: { type: 'input_text'; text: string }[] }
        | { type: 'function_call_output'; call_id: string; output: string };
    };

/** The Realtime server events acted on. Every other event is ignored. */
type RealtimeServerEvent =
  | {
      type:
        | 'session.updated'
        | 'input_audio_buffer.speech_started'
        | 'input_audio_buffer.speech_stopped'
        | 'response.created'
        | 'output_audio_buffer.started'
        | 'output_audio_buffer.stopped'
        | 'output_audio_buffer.cleared'
        | 'response.done'
        | 'error';
    }
  | { type: 'response.output_audio_transcript.done'; transcript: string }
  | { type: 'response.function_call_arguments.done'; name: string; arguments: string; call_id: string };

export type VoicePhase = 'connecting' | 'hearing' | 'speaking' | 'thinking' | 'muted' | 'listening';

/** Why a call ended by itself. A call closed with `close()` reports nothing. */
export type VoiceEnd =
  | { kind: 'timeout' | 'failed' | 'disconnected' | 'error' }
  | {
      kind: 'not_started';
      /** `microphone`: the browser gave no microphone. `service`: `/voice` refused, or the network failed. */
      stage: 'microphone' | 'service';
      /** The HTTP status of a refusal by `/voice`; 0 for anything else. */
      status: number;
      /** The server's or the browser's own explanation, in English. May be empty. */
      message: string;
      /** The name of the browser's error, such as `NotAllowedError` when the microphone was refused; else empty. */
      name: string;
    };

/** What the call needs from a browser. */
export type VoicePlatform = {
  getUserMedia: (constraints: { audio: true }) => Promise<MediaStream>;
  createPeer: () => RTCPeerConnection;
  fetch: typeof fetch;
};

/** What this browser can do: a peer connection is needed to talk at all, a microphone to speak. */
export function voiceSupport() {
  return {
    peer: 'RTCPeerConnection' in globalThis,
    microphone: Boolean(globalThis.navigator?.mediaDevices?.getUserMedia),
  };
}

const browserPlatform = (): VoicePlatform => ({
  getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
  createPeer: () => new RTCPeerConnection(),
  fetch: (input, init) => fetch(input, init),
});

export type VoiceCallOptions = {
  /** Where the SDP offer is posted: `voice` on the interview page, an absolute URL from the card. */
  endpoint: string;
  /**
   * False: no microphone is asked for. The assistant still speaks and the person answers with
   * `sayTyped`, for a frame or a person that gives no microphone. Default true.
   */
  microphone?: boolean;
  /** What the session is told when it starts, and again after a change of language. */
  context: () => Promise<VoiceContext>;
  /** Answer one function call of the session. A rejection is reported to the model as a failure. */
  runTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onPhase: (phase: VoicePhase) => void;
  /** The service accepted the settings: the conversation is live. */
  onGreeted: () => void;
  /** What the assistant just said, as text. */
  onCaption: (text: string) => void;
  /** Whether a typed reply can be sent now: only between turns. */
  onCanSend: (allowed: boolean) => void;
  /** The assistant's audio, to play. */
  onRemoteStream: (stream: MediaStream) => void;
  onEnd: (reason: VoiceEnd) => void;
  platform?: VoicePlatform;
  /** How long the call may take to become live. Default 45 seconds. */
  timeoutMs?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const plainServerEvents = new Set([
  'session.updated',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'response.created',
  'output_audio_buffer.started',
  'output_audio_buffer.stopped',
  'output_audio_buffer.cleared',
  'response.done',
  'error',
]);

/** Narrow one data-channel message to an event that is handled; null for everything else. */
export function readServerEvent(raw: unknown): RealtimeServerEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.type !== 'string') return null;
  const { type } = data;
  if (plainServerEvents.has(type)) return data as RealtimeServerEvent;
  if (type === 'response.output_audio_transcript.done') {
    return typeof data.transcript === 'string' && data.transcript ? { type, transcript: data.transcript } : null;
  }
  if (type === 'response.function_call_arguments.done') {
    const { name, arguments: args, call_id } = data;
    return typeof name === 'string' && typeof args === 'string' && typeof call_id === 'string'
      ? { type, name, arguments: args, call_id }
      : null;
  }
  return null;
}

/** Every function either surface gives the session; a call of any other name is ignored. */
const voiceToolNames = new Set(voiceTools().map(tool => tool.name));

/** `/voice` refused the offer, or the browser gave no microphone. */
class NotStarted extends Error {
  readonly stage: 'microphone' | 'service';
  readonly status: number;
  readonly cause: string;
  constructor(stage: 'microphone' | 'service', status: number, message: string, cause = '') {
    super(message);
    this.stage = stage;
    this.status = status;
    this.cause = cause;
  }
}

/** Start a call. It reports its own end through `onEnd`; `close()` ends it silently. */
export function startVoiceCall(options: VoiceCallOptions) {
  const platform = options.platform ?? browserPlatform();
  const microphone = options.microphone ?? true;
  const peer = platform.createPeer();
  const abort = new AbortController();
  let ended = false;
  let stream: MediaStream | undefined;
  let send: ((event: RealtimeClientEvent) => void) | undefined;
  /** The data channel is open and the session settings were sent. */
  let configured = false;
  /** The service accepted the settings and the first reply was requested. */
  let greeted = false;
  /** The service refused the settings once and they were sent again without transcription. */
  let plain = false;
  /** New settings were sent after a language change and are not acknowledged yet. */
  let updating = false;
  let responding = false;
  let playing = false;
  let userSpeaking = false;
  let muted = false;
  let canSend = false;
  /** Something to tell the session at the next quiet moment (a new bank summary), as a system message. */
  let pendingNote: (() => string) | null = null;
  /** A tool result was sent and the model still owes a spoken reply. */
  let followUp = false;
  let pendingTools = 0;

  function close() {
    if (ended) return;
    ended = true;
    abort.abort();
    clearTimeout(timer);
    peer.close();
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
  function fail(reason: VoiceEnd) {
    if (ended) return;
    close();
    options.onEnd(reason);
  }
  const timer = setTimeout(() => fail({ kind: 'timeout' }), options.timeoutMs ?? 45_000);

  const phase = (): VoicePhase =>
    userSpeaking ? 'hearing' : playing ? 'speaking' : responding ? 'thinking' : muted ? 'muted' : 'listening';
  const render = () => options.onPhase(phase());
  function allowTyping(allowed: boolean) {
    canSend = allowed;
    options.onCanSend(allowed);
  }

  function requestReply() {
    responding = true;
    allowTyping(false);
    render();
    send?.({ type: 'response.create' });
  }

  function shareNoteWhenReady() {
    if (!greeted || !pendingNote || responding || playing || userSpeaking || pendingTools) return false;
    const text = pendingNote();
    pendingNote = null;
    send?.({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
    requestReply();
    return true;
  }

  function finishTurn() {
    if (responding || playing || userSpeaking || pendingTools) return;
    if (shareNoteWhenReady()) {
      followUp = false;
    } else if (followUp) {
      followUp = false;
      requestReply();
    } else {
      allowTyping(true);
    }
  }

  async function handle(raw: unknown) {
    if (ended) return;
    const data = readServerEvent(raw);
    if (!data) return;
    if (data.type === 'session.updated') updating = false;
    if (data.type === 'session.updated' && !greeted) {
      clearTimeout(timer);
      greeted = true;
      options.onGreeted();
      if (!shareNoteWhenReady()) requestReply();
    }
    if (data.type === 'input_audio_buffer.speech_started') {
      userSpeaking = true;
      allowTyping(false);
      render();
    }
    if (data.type === 'input_audio_buffer.speech_stopped') {
      userSpeaking = false;
      responding = true;
      render();
    }
    if (data.type === 'response.created') {
      responding = true;
      allowTyping(false);
      render();
    }
    if (data.type === 'output_audio_buffer.started') {
      playing = true;
      render();
    }
    if (data.type === 'output_audio_buffer.stopped' || data.type === 'output_audio_buffer.cleared') {
      playing = false;
      render();
      finishTurn();
    }
    if (data.type === 'response.output_audio_transcript.done') options.onCaption(data.transcript);
    if (data.type === 'response.function_call_arguments.done' && voiceToolNames.has(data.name)) {
      pendingTools++;
      let output: Record<string, unknown>;
      try {
        const args: unknown = JSON.parse(data.arguments);
        if (!isRecord(args)) throw new Error('Tool arguments must be an object.');
        output = await options.runTool(data.name, args);
      } catch {
        output = { error: 'The requested action could not be completed.' };
      }
      pendingTools--;
      if (ended) return;
      send?.({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: data.call_id, output: JSON.stringify(output) },
      });
      followUp = true;
      finishTurn();
    }
    if (data.type === 'response.done') {
      responding = false;
      render();
      finishTurn();
    }
    if (data.type === 'error') {
      if (updating) {
        // New settings after a language change were refused: the conversation goes on with the ones it had.
        updating = false;
      } else if (!greeted && !plain) {
        // The first settings were refused: send them once more without transcription, as before it existed.
        plain = true;
        const context = await options.context();
        if (!ended) send?.(sessionUpdate(context, { transcription: false }));
      } else fail({ kind: 'error' });
    }
  }

  async function connect() {
    try {
      if (microphone) {
        let media: MediaStream;
        try {
          media = await platform.getUserMedia({ audio: true });
        } catch (error) {
          // A browser rejects with a DOMException; only its name says whether the person refused or there is none.
          const name = (error as { name?: unknown } | null)?.name;
          throw new NotStarted('microphone', 0, errorMessage(error), typeof name === 'string' ? name : '');
        }
        if (ended) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream = media;
        peer.addTrack(media.getAudioTracks()[0], media);
      } else {
        // Nothing is sent, the assistant is still heard: the offer carries one audio line to receive on.
        peer.addTransceiver('audio', { direction: 'recvonly' });
      }
      peer.ontrack = event => {
        if (!ended) options.onRemoteStream(event.streams[0]);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') fail({ kind: 'failed' });
      };
      const channel = peer.createDataChannel('oai-events');
      send = event => channel.send(JSON.stringify(event));
      channel.onclose = () => fail({ kind: 'disconnected' });
      channel.onopen = () => {
        // The functions, the instructions with the surface's labels, and the language to transcribe (`voice.ts`).
        void options
          .context()
          .then(context => {
            if (ended) return;
            configured = true;
            send?.(sessionUpdate(context));
          })
          .catch(() => fail({ kind: 'error' }));
      };
      // A failure while answering an event (the context could not be read) ends the call instead of leaving it mute.
      channel.onmessage = event => void handle(event.data).catch(() => fail({ kind: 'error' }));
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await platform.fetch(options.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
        signal: abort.signal,
      });
      if (!response.ok) {
        // The server explains a refusal as `{ error }`; an answer that is not JSON is a refusal all the same.
        const failure: unknown = await response.json().catch(() => null);
        throw new NotStarted(
          'service',
          response.status,
          isRecord(failure) && typeof failure.error === 'string' ? failure.error : '',
        );
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
      fail({
        kind: 'not_started',
        stage: error instanceof NotStarted ? error.stage : 'service',
        status: error instanceof NotStarted ? error.status : 0,
        message: errorMessage(error),
        name: error instanceof NotStarted ? error.cause : '',
      });
    }
  }

  options.onPhase('connecting');
  void connect();

  return {
    /** End the call: the peer, the microphone and the pending request. Nothing is reported. */
    close,
    get configured() {
      return configured;
    },
    get greeted() {
      return greeted;
    },
    get muted() {
      return muted;
    },
    /** False when the call has no microphone to mute. */
    setMuted(value: boolean) {
      if (!stream || ended) return false;
      muted = value;
      for (const track of stream.getAudioTracks()) track.enabled = !muted;
      render();
      return true;
    },
    /** A typed reply, as the person's turn. False when it cannot be sent now (mid-turn, or not live). */
    sayTyped(text: string) {
      if (!send || !canSend || !text || ended) return false;
      send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      requestReply();
      return true;
    },
    /** Tell the session something at the next quiet moment; the text is built when it is sent. */
    shareWhenQuiet(note: () => string) {
      pendingNote = note;
      shareNoteWhenReady();
    },
    /**
     * The person changed the language shown: the session is told, so the next spoken turn is in it, and
     * its settings follow (the labels it names and the language its transcription expects).
     */
    async changeLanguage(chosen: Locale) {
      if (!greeted || ended) return;
      send?.({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: voiceLanguageChange(chosen) }] },
      });
      const context = await options.context();
      if (ended || context.locale !== chosen) return;
      updating = true;
      send?.(sessionUpdate(context, { transcription: !plain }));
    },
  };
}
export type VoiceCall = ReturnType<typeof startVoiceCall>;
