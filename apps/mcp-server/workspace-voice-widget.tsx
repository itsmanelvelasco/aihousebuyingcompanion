import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { inputSchema } from '../../packages/contracts/inputs.ts';

z.config({ jitless: true });

export function validateVoiceAnswers(data: unknown): Record<string, unknown> {
  return inputSchema.parse({ id: 'voice-draft', source: 'interview', observedAt: new Date().toISOString(),
    confirmed: false, synthetic: true, data }).data as Record<string, unknown>;
}

type Props = { call: (sdp: string) => Promise<string>; onAnswers: (data: Record<string, unknown>) => void; onError?: (message: string) => void };
type Session = { peer: RTCPeerConnection; stream?: MediaStream; channel?: RTCDataChannel; timer?: ReturnType<typeof setTimeout> };

export function VoiceInterview({ call, onAnswers, onError }: Props) {
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'active'>('idle');
  const [status, setStatus] = useState('Voice is optional. You can always use the guided interview.');
  const [caption, setCaption] = useState('');
  const [muted, setMuted] = useState(false);
  const session = useRef<Session | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const callbacks = useRef({ call, onAnswers, onError });
  callbacks.current = { call, onAnswers, onError };

  function release() {
    const current = session.current;
    session.current = null;
    if (!current) return;
    clearTimeout(current.timer);
    current.stream?.getTracks().forEach(track => track.stop());
    current.channel?.close();
    current.peer.close();
    if (audio.current) { audio.current.pause(); audio.current.srcObject = null; }
  }
  function stop(message = 'Voice ended. Review your draft answers before saving.') {
    release(); setPhase('idle'); setMuted(false); setStatus(message);
  }
  useEffect(() => () => release(), []);

  async function start() {
    if (session.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      const message = 'This host does not expose microphone or WebRTC access. Use the guided interview or ChatGPT voice.';
      setStatus(message); callbacks.current.onError?.(message); return;
    }
    let current: Session;
    try { current = { peer: new RTCPeerConnection() }; }
    catch { setStatus('Voice is unavailable in this host. Use the guided interview.'); return; }
    session.current = current;
    setPhase('connecting'); setCaption(''); setStatus('Requesting microphone access…');
    current.timer = setTimeout(() => {
      if (session.current === current) stop('Voice did not connect in time. Use the guided interview or try again.');
    }, 45000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session.current !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      for (const track of stream.getAudioTracks()) current.peer.addTrack(track, stream);
      current.peer.ontrack = event => {
        if (session.current === current && audio.current) {
          audio.current.srcObject = event.streams[0];
          void audio.current.play().catch(() => setStatus('Audio playback is blocked. Use the audio controls or the guided interview.'));
        }
      };
      current.peer.onconnectionstatechange = () => {
        if (session.current === current && ['failed', 'closed', 'disconnected'].includes(current.peer.connectionState)) stop('Voice disconnected. Your unsaved draft remains available for review.');
      };
      const channel = current.peer.createDataChannel('oai-events'); current.channel = channel;
      const send = (value: unknown) => { if (channel.readyState === 'open') channel.send(JSON.stringify(value)); };
      channel.onopen = () => {
        if (session.current !== current) return;
        send({ type: 'session.update', session: {
          type: 'realtime',
          instructions: 'You are ReloCat’s homebuying interviewer. Ask one short question at a time in the person’s language. Begin by asking whether they want to use fictional bank information or describe rough income and spending. Never ask for credentials or an account number. Then confirm household size, buy or rent, housing budget, location and commute, school needs, savings target and reserve. Monetary canonical fields are INTEGER EURO CENTS: convert explicitly stated euro amounts by multiplying by 100 and confirm the interpretation. A home purchase budget is not a savings target. Ask about missing facts; never infer an expense from a contribution or bank balance from purchase savings. Use save_interview_answers only for explicitly supplied supported facts. Tool results prepare an UNSAVED draft; tell the person to review and press Save. Never claim persistence, eligibility, mortgage approval or invented timelines. If the person asks to import bank data, direct them to the Bank tab; you cannot connect real accounts. Stop after each question and listen.',
          audio: { input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } } },
          tools: [{ type: 'function', name: 'save_interview_answers', description: 'Prepare a validated partial canonical interview draft. Does not write the API; person must review and explicitly save.',
            parameters: z.toJSONSchema(inputSchema.shape.data, { io: 'input' }) }],
        } });
      };
      let greeted = false;
      let responseActive = false;
      let needsFollowUp = false;
      const requestReply = () => {
        if (responseActive) { needsFollowUp = true; return; }
        needsFollowUp = false; responseActive = true;
        send({ type: 'response.create' });
      };
      channel.onmessage = event => {
        if (session.current !== current || typeof event.data !== 'string' || event.data.length > 262144) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
        if (message.type === 'session.updated' && !greeted) {
          greeted = true; clearTimeout(current.timer); setPhase('active'); setStatus('Listening. Your answers prepare a draft for review.');
          requestReply();
        }
        if (message.type === 'response.output_audio_transcript.done' && typeof message.transcript === 'string') setCaption(message.transcript);
        if (message.type === 'response.created') responseActive = true;
        if (message.type === 'response.done') {
          responseActive = false;
          if (needsFollowUp) requestReply();
        }
        if (message.type === 'input_audio_buffer.speech_started') setStatus('Listening…');
        if (message.type === 'output_audio_buffer.started') setStatus('Interviewer speaking…');
        if (message.type === 'output_audio_buffer.stopped') setStatus('Listening. You can stop at any time.');
        if (message.type === 'response.function_call_arguments.done' && message.name === 'save_interview_answers') {
          let output: Record<string, unknown>;
          try {
            if (typeof message.arguments !== 'string' || message.arguments.length > 32768) throw new Error();
            const answers = validateVoiceAnswers(JSON.parse(message.arguments));
            callbacks.current.onAnswers(answers);
            output = { preparedDraft: true, saved: false, instruction: 'Ask the person to review and explicitly save this draft.' };
          } catch { output = { preparedDraft: false, saved: false, error: 'Unsupported or invalid answers. Ask for clarification without inventing facts.' }; }
          send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: message.call_id, output: JSON.stringify(output) } });
          requestReply();
        }
        if (message.type === 'error') stop('The voice service reported an error. Use the guided interview or try again.');
      };
      channel.onclose = () => { if (session.current === current) stop('Voice ended. Review your draft before saving.'); };
      const offer = await current.peer.createOffer();
      if (session.current !== current) return;
      await current.peer.setLocalDescription(offer);
      if (session.current !== current) return;
      setStatus('Connecting the voice session using configured API credits…');
      const answer = await callbacks.current.call(offer.sdp ?? '');
      if (session.current !== current) return;
      await current.peer.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch {
      if (session.current !== current) return;
      const message = 'Voice could not connect or microphone access was denied. Use the guided interview or ChatGPT voice.';
      stop(message); callbacks.current.onError?.(message);
    }
  }

  function toggleMute() {
    const next = !muted;
    session.current?.stream?.getAudioTracks().forEach(track => { track.enabled = !next; });
    setMuted(next);
  }
  return <section aria-label="Optional voice interview" className="panel voice-interview">
    <h3>Talk through your needs</h3>
    <p>Voice uses configured OpenAI API credits after you press Start voice and allow microphone access. Answers remain an unsaved draft until you review and save.</p>
    <p role="status">{status}</p>
    <div className="actions">
      {phase === 'idle' ? <button className="primary" type="button" onClick={() => void start()}>Start voice</button>
        : <><button type="button" onClick={() => stop()}>Stop voice</button><button type="button" onClick={toggleMute} aria-pressed={muted} disabled={phase === 'connecting'}>{muted ? 'Unmute microphone' : 'Mute microphone'}</button></>}
    </div>
    {caption && <p aria-live="polite">{caption}</p>}
    <audio ref={audio} autoPlay controls aria-label="Interviewer audio" />
  </section>;
}
