import { createFormat } from '../../packages/i18n/format.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import { card } from './card.messages.ts';
import type { CallTool, ProfileAccess, ToolAnswer } from './facts.ts';
import { voiceFactContext } from './facts.ts';
import type { VoiceEnd } from './realtime.ts';
import type { Interview, PlanOutcome } from './session.ts';
import type { VoiceContext } from './voice.ts';

/**
 * How the interview card talks to the chat it is embedded in. No DOM: `card.ts` draws, this file
 * decides, and `tests/interviewer-card.test.ts` runs it against a fake host.
 *
 * The card runs on the host's sandbox origin, with no ReloCat cookie. Every ReloCat tool is called
 * through the host (`App.callServerTool`), which uses the person's own connection to the MCP
 * server: the same identity, the same tools and the same results the model gets.
 */

/** The part of `App` (`@modelcontextprotocol/ext-apps`) the card uses. */
export type HostApp = {
  getHostCapabilities(): { serverTools?: unknown } | undefined;
  callServerTool(
    params: { name: string; arguments: Record<string, unknown> },
    options?: { timeout: number },
  ): Promise<ToolAnswer>;
  sendMessage(
    params: { role: 'user'; content: { type: 'text'; text: string }[] },
    options?: { timeout: number },
  ): Promise<{ isError?: boolean }>;
};
/** ChatGPT's own bridge, when the card runs there. */
export type OpenAiHost = { sendFollowUpMessage?: (message: { prompt: string }) => unknown };

const requestOptions = { timeout: 15_000 };

/**
 * `CallTool` through the host. Null when there is no host, the handshake has not finished, the host
 * offers no server tools, or the call fails: the interview then keeps the answers in the card.
 */
export function hostCallTool(app: HostApp | null, connected: () => boolean): CallTool {
  return async (name, args) => {
    if (!app || !connected() || !app.getHostCapabilities()?.serverTools) return null;
    try {
      return await app.callServerTool({ name, arguments: args }, requestOptions);
    } catch {
      return null;
    }
  };
}

/**
 * Whether the person's ReloCat account is connected in this chat. `start_homebuying_interview` is the
 * tool that shows the card, it reads no personal data and says `signedIn`; `show_workspace`, which
 * the page asks, is a tool only the model may call. No answer: the card cannot reach the tools.
 */
export async function hostAccess(call: CallTool): Promise<ProfileAccess> {
  const answer = await call('start_homebuying_interview', {});
  const data = answer && !answer.isError ? (answer.structuredContent as { signedIn?: unknown } | undefined) : undefined;
  if (typeof data?.signedIn !== 'boolean') return 'standalone';
  return data.signedIn ? 'signed_in' : 'signed_out';
}

/** The sentence said once, by voice and in the card, when the answers are not being saved. */
export const notSavedNotice = (locale: () => Locale) => (access: Exclude<ProfileAccess, 'signed_in'>) =>
  translator(card, locale())(access === 'signed_out' ? 'notSaved' : 'noTools');

/**
 * Put a message into the chat as the person's own: ChatGPT's bridge when it is there, else the MCP
 * Apps request. False when the host offers neither or refuses, and the card then shows the sentence
 * to type.
 */
export async function sendToChat(host: { openai?: OpenAiHost; app: HostApp | null }, text: string) {
  try {
    if (typeof host.openai?.sendFollowUpMessage === 'function') {
      await host.openai.sendFollowUpMessage({ prompt: text });
      return true;
    }
    if (!host.app) return false;
    const sent = await host.app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }, requestOptions);
    return !sent.isError;
  } catch {
    return false;
  }
}

/** The message that asks ReloCat, in the chat, to show the workspace for the towns of the plan. */
export function workspaceRequest(towns: readonly string[], locale: Locale) {
  const t = translator(card, locale);
  return towns.length
    ? t('workspaceMessage', { towns: createFormat(locale).list([...towns]) })
    : t('workspaceMessageNoTowns');
}

/** The towns a workspace request names: the ones chosen here, else the ones the last plan compared. */
export function workspaceTowns(interview: Pick<Interview, 'journey' | 'lastPlan'>) {
  const chosen = interview.journey.places.map(place => place.name);
  return chosen.length ? chosen : (interview.lastPlan?.plans.map(plan => plan.place.name) ?? []);
}

/** What the voice session is told when it starts in the card: no statement, and the card's own surface. */
export async function cardVoiceContext(interview: Interview, locale: Locale, today: string): Promise<VoiceContext> {
  const { answers, extras, places } = interview.journey;
  return {
    surface: 'card',
    locale,
    access: interview.access,
    cash: null,
    statementCurrency: 'EUR',
    bankSource: null,
    cashGuidance: '',
    // Ids only: no value of an answer is sent with the instructions.
    answeredIds: [
      ...voiceFactContext(answers, today).answeredFactIds,
      ...(extras.householdSize === undefined ? [] : ['householdSize']),
      ...(extras.targetCashCents === undefined ? [] : ['targetCash']),
    ],
    places: places.map(place => place.name),
    nextQuestion: interview.spoken(await interview.nextQuestion()),
  };
}

/**
 * The functions of the voice session, answered in the card: the same interview as the page, with the
 * plan shown in the card and the workspace asked for in the chat.
 */
export function cardVoiceTools(deps: {
  interview: Interview;
  /** Read the plan and show its summary in the card. */
  showPlan: () => Promise<PlanOutcome>;
  /** Ask for the workspace in the chat. False when the message could not be sent. */
  askForWorkspace: () => Promise<boolean>;
}) {
  const { interview } = deps;
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (name) {
      case 'save_interview_answers':
        return interview.saveSpoken(args);
      case 'save_place':
        return interview.savePlaceSpoken(args);
      case 'show_plan': {
        // The page's link to the workspace means nothing in a chat: the workspace is asked for there.
        const { workspaceLink: _, ...spoken } = await interview.planSpoken(await deps.showPlan());
        return spoken.shown
          ? { ...spoken, shownIn: 'the card', workspace: 'Call open_workspace to ask for it in the chat.' }
          : spoken;
      }
      case 'open_workspace':
        return (await deps.askForWorkspace())
          ? { opened: true, where: 'asked for in the chat', towns: workspaceTowns(interview) }
          : {
              opened: false,
              buttonInCard: true,
              reason:
                'The request could not be sent to the chat from here. The button is in the card: ask them to press it.',
            };
      case 'save_to_profile':
        return interview.saveAllSpoken();
      default:
        return { error: 'This is not available in the card.' };
    }
  };
}

export type CardFailure = {
  /** The sentence of `card.messages.ts` that explains it. */
  key: 'micRefused' | 'micUnavailable' | 'voiceRefused' | 'voiceBusy' | 'voiceOff' | 'voiceNetwork' | 'voiceDropped';
  /** The conversation can go on without a microphone: the assistant speaks and the person types. */
  offerTyping: boolean;
};

/** Why a call ended by itself, as what the card says and offers. Continuing in the chat is always offered. */
export function cardFailure(reason: VoiceEnd): CardFailure {
  if (reason.kind !== 'not_started') return { key: 'voiceDropped', offerTyping: false };
  if (reason.stage === 'microphone') {
    const refused = reason.name === 'NotAllowedError' || reason.name === 'SecurityError';
    return { key: refused ? 'micRefused' : 'micUnavailable', offerTyping: true };
  }
  const key =
    reason.status === 403
      ? 'voiceRefused'
      : reason.status === 429
        ? 'voiceBusy'
        : reason.status === 503
          ? 'voiceOff'
          : 'voiceNetwork';
  return { key, offerTyping: false };
}
