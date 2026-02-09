import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { ensureBrowserUtils } from "../../utils/injection";
import {
  googleParticipantSelectors,
  googleSpeakingClassNames,
  googleSilenceClassNames,
  googleParticipantContainerSelectors,
  googleNameSelectors,
  googleSpeakingIndicators,
  googlePeopleButtonSelectors
} from "./selectors";

export interface SpeakerDetectionService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getActiveParticipants(): string[];
  getActiveParticipantsCount(): number;
}

export interface SpeakerEvent {
  eventType: 'SPEAKER_START' | 'SPEAKER_END';
  participantName: string;
  participantId: string;
  timestamp: number;
}

export type SpeakerEventCallback = (event: SpeakerEvent) => void;

export async function initializeSpeakerDetection(
  page: Page,
  botConfig: BotConfig,
  onSpeakerEvent?: SpeakerEventCallback
): Promise<SpeakerDetectionService> {
  await ensureBrowserUtils(page, require('path').join(__dirname, '../../browser-utils.global.js'));

  const speakerServiceHandle = await page.evaluate(
    async (pageArgs: {
      botConfigData: BotConfig;
      selectors: {
        participantSelectors: string[];
        speakingClasses: string[];
        silenceClasses: string[];
        containerSelectors: string[];
        nameSelectors: string[];
        speakingIndicators: string[];
        peopleButtonSelectors: string[];
      };
    }) => {
      const { botConfigData, selectors } = pageArgs;
      const selectorsTyped = selectors as any;

      (window as any).logBot("Initializing Google Meet speaker detection...");

      const speakingStates = new Map<string, string>();
      const speakerEvents: SpeakerEvent[] = [];
      let sessionStartTime: number | null = null;

      function hashStr(s: string): string {
        // small non-crypto hash to avoid logging PII
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
        return (h >>> 0).toString(16).slice(0, 8);
      }

      function getGoogleParticipantId(element: HTMLElement) {
        let id = element.getAttribute('data-participant-id');
        if (!id) {
          const stableChild = element.querySelector('[jsinstance]') as HTMLElement | null;
          if (stableChild) {
            id = stableChild.getAttribute('jsinstance') || undefined as any;
          }
        }
        if (!id) {
          if (!(element as any).dataset.vexaGeneratedId) {
            (element as any).dataset.vexaGeneratedId = 'gm-id-' + Math.random().toString(36).substr(2, 9);
          }
          id = (element as any).dataset.vexaGeneratedId;
        }
        return id as string;
      }

      function getGoogleParticipantName(participantElement: HTMLElement) {
        // Prefer explicit Meet name spans
        const notranslate = participantElement.querySelector('span.notranslate') as HTMLElement | null;
        if (notranslate && notranslate.textContent && notranslate.textContent.trim()) {
          const t = notranslate.textContent.trim();
          if (t.length > 1 && t.length < 50) return t;
        }

        // Try configured name selectors
        const nameSelectors: string[] = selectorsTyped.nameSelectors || [];
        for (const sel of nameSelectors) {
          const el = participantElement.querySelector(sel) as HTMLElement | null;
          if (el) {
            let nameText = el.textContent || el.innerText || el.getAttribute('data-self-name') || el.getAttribute('aria-label') || '';
            if (nameText) {
              nameText = nameText.trim();
              if (nameText && nameText.length > 1 && nameText.length < 50) return nameText;
            }
          }
        }

        // Fallbacks
        const selfName = participantElement.getAttribute('data-self-name');
        if (selfName && selfName.trim()) return selfName.trim();
        const idToDisplay = getGoogleParticipantId(participantElement);
        return `Google Participant (${idToDisplay})`;
      }

      function isVisible(el: HTMLElement): boolean {
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const ariaHidden = el.getAttribute('aria-hidden') === 'true';
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          cs.display !== 'none' &&
          cs.visibility !== 'hidden' &&
          cs.opacity !== '0' &&
          !ariaHidden
        );
      }

      function hasSpeakingIndicator(container: HTMLElement): boolean {
        const indicators: string[] = selectorsTyped.speakingIndicators || [];
        for (const sel of indicators) {
          const ind = container.querySelector(sel) as HTMLElement | null;
          if (ind && isVisible(ind)) return true;
        }
        return false;
      }

      function inferSpeakingFromClasses(container: HTMLElement, mutatedClassList?: DOMTokenList): { speaking: boolean } {
        const speakingClasses: string[] = selectorsTyped.speakingClasses || [];
        const silenceClasses: string[] = selectorsTyped.silenceClasses || [];

        const classList = mutatedClassList || container.classList;
        const descendantSpeaking = speakingClasses.some(cls => container.querySelector('.' + cls));
        const hasSpeaking = speakingClasses.some(cls => classList.contains(cls)) || descendantSpeaking;
        const hasSilent = silenceClasses.some(cls => classList.contains(cls));
        if (hasSpeaking) return { speaking: true };
        if (hasSilent) return { speaking: false };
        return { speaking: false };
      }

      function sendGoogleSpeakerEvent(eventType: 'SPEAKER_START' | 'SPEAKER_END', participantElement: HTMLElement) {
        if (sessionStartTime === null) {
          sessionStartTime = Date.now();
        }
        const relativeTimestampMs = Date.now() - sessionStartTime;
        const participantId = getGoogleParticipantId(participantElement);
        const participantName = getGoogleParticipantName(participantElement);
        
        const event: SpeakerEvent = {
          eventType,
          participantName,
          participantId,
          timestamp: relativeTimestampMs
        };

        speakerEvents.push(event);
        
        // Log the event
        if (eventType === 'SPEAKER_START') {
          (window as any).logBot(`🎤 [Google] SPEAKER_START: ${participantName} (ID: ${participantId})`);
        } else {
          (window as any).logBot(`🔇 [Google] SPEAKER_END: ${participantName} (ID: ${participantId})`);
        }
      }

      function logGoogleSpeakerEvent(participantElement: HTMLElement, mutatedClassList?: DOMTokenList) {
        const participantId = getGoogleParticipantId(participantElement);
        const participantName = getGoogleParticipantName(participantElement);
        const previousLogicalState = speakingStates.get(participantId) || 'silent';

        // Primary: indicators; Fallback: classes
        const indicatorSpeaking = hasSpeakingIndicator(participantElement);
        const classInference = inferSpeakingFromClasses(participantElement, mutatedClassList);
        const isCurrentlySpeaking = indicatorSpeaking || classInference.speaking;

        if (isCurrentlySpeaking) {
          if (previousLogicalState !== 'speaking') {
            sendGoogleSpeakerEvent('SPEAKER_START', participantElement);
          }
          speakingStates.set(participantId, 'speaking');
        } else {
          if (previousLogicalState === 'speaking') {
            sendGoogleSpeakerEvent('SPEAKER_END', participantElement);
          }
          speakingStates.set(participantId, 'silent');
        }
      }

      function observeGoogleParticipant(participantElement: HTMLElement) {
        const participantId = getGoogleParticipantId(participantElement);
        speakingStates.set(participantId, 'silent');

        // Initial scan
        logGoogleSpeakerEvent(participantElement);

        const callback = function(mutationsList: MutationRecord[]) {
          for (const mutation of mutationsList) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
              const targetElement = mutation.target as HTMLElement;
              if (participantElement.contains(targetElement) || participantElement === targetElement) {
                logGoogleSpeakerEvent(participantElement, targetElement.classList);
              }
            }
          }
        };

        const observer = new MutationObserver(callback);
        observer.observe(participantElement, {
          attributes: true,
          attributeFilter: ['class'],
          subtree: true
        });

        if (!(participantElement as any).dataset.vexaObserverAttached) {
          (participantElement as any).dataset.vexaObserverAttached = 'true';
        }
      }

      function scanForAllGoogleParticipants() {
        const participantSelectors: string[] = selectorsTyped.participantSelectors || [];
        for (const sel of participantSelectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const elh = el as HTMLElement;
            if (!(elh as any).dataset.vexaObserverAttached) {
              observeGoogleParticipant(elh);
            }
          });
        }
      }

      let pollingInterval: number | null = null;

      const startDetection = async () => {
        try {
          sessionStartTime = Date.now();

          // Attempt to click People button to stabilize DOM if available
          try {
            const peopleSelectors: string[] = selectorsTyped.peopleButtonSelectors || [];
            for (const sel of peopleSelectors) {
              const btn = document.querySelector(sel) as HTMLElement | null;
              if (btn && isVisible(btn)) { btn.click(); break; }
            }
          } catch {}

          // Initialize
          scanForAllGoogleParticipants();

          // Polling fallback to catch speaking indicators not driven by class mutations
          const lastSpeakingById = new Map<string, boolean>();
          pollingInterval = window.setInterval(() => {
            const participantSelectors: string[] = selectorsTyped.participantSelectors || [];
            const elements: HTMLElement[] = [];
            participantSelectors.forEach(sel => {
              document.querySelectorAll(sel).forEach(el => elements.push(el as HTMLElement));
            });
            
            elements.forEach((container) => {
              const id = getGoogleParticipantId(container);
              const indicatorSpeaking = hasSpeakingIndicator(container) || inferSpeakingFromClasses(container).speaking;
              const prev = lastSpeakingById.get(id) || false;
              if (indicatorSpeaking && !prev) {
                (window as any).logBot(`[Google Poll] SPEAKER_START ${getGoogleParticipantName(container)}`);
                sendGoogleSpeakerEvent('SPEAKER_START', container);
                lastSpeakingById.set(id, true);
                speakingStates.set(id, 'speaking');
              } else if (!indicatorSpeaking && prev) {
                (window as any).logBot(`[Google Poll] SPEAKER_END ${getGoogleParticipantName(container)}`);
                sendGoogleSpeakerEvent('SPEAKER_END', container);
                lastSpeakingById.set(id, false);
                speakingStates.set(id, 'silent');
              } else if (!lastSpeakingById.has(id)) {
                lastSpeakingById.set(id, indicatorSpeaking);
              }
            });
          }, 500);

          (window as any).logBot("Speaker detection started successfully.");
        } catch (error: any) {
          (window as any).logBot(`[Speaker Detection Error] ${error.message}`);
          throw error;
        }
      };

      const stopDetection = () => {
        if (pollingInterval !== null) {
          clearInterval(pollingInterval);
          pollingInterval = null;
        }
        (window as any).logBot("Speaker detection stopped.");
      };

      const extractParticipantsFromMain = (botName: string | undefined): string[] => {
        const participants: string[] = [];
        const mainElement = document.querySelector('main');
        if (mainElement) {
          const nameElements = mainElement.querySelectorAll('*');
          nameElements.forEach((el: Element) => {
            const element = el as HTMLElement;
            const text = (element.textContent || '').trim();
            if (text && element.children.length === 0) {
              if ((text.length > 1 && text.length < 50) || (botName && text === botName)) {
                participants.push(text);
              }
            }
          });
        }
        const tooltips = document.querySelectorAll('main [role="tooltip"]');
        tooltips.forEach((el: Element) => {
          const text = (el.textContent || '').trim();
          if (text && ((text.length > 1 && text.length < 50) || (botName && text === botName))) {
            participants.push(text);
          }
        });
        return Array.from(new Set(participants));
      };

      const getActiveParticipants = () => {
        const names = extractParticipantsFromMain((botConfigData as any)?.botName);
        (window as any).logBot(`🔍 [Google Meet Participants] ${JSON.stringify(names)}`);
        return names;
      };

      const getActiveParticipantsCount = () => {
        return getActiveParticipants().length;
      };

      // Expose methods globally
      (window as any).__vexaSpeakerStart = startDetection;
      (window as any).__vexaSpeakerStop = stopDetection;
      (window as any).__vexaGetActiveParticipants = getActiveParticipants;
      (window as any).__vexaGetActiveParticipantsCount = getActiveParticipantsCount;
      (window as any).__vexaSpeakerEvents = speakerEvents;

      return {
        start: startDetection,
        stop: stopDetection,
        getActiveParticipants: getActiveParticipants,
        getActiveParticipantsCount: getActiveParticipantsCount
      };
    },
    {
      botConfigData: botConfig,
      selectors: {
        participantSelectors: googleParticipantSelectors,
        speakingClasses: googleSpeakingClassNames,
        silenceClasses: googleSilenceClassNames,
        containerSelectors: googleParticipantContainerSelectors,
        nameSelectors: googleNameSelectors,
        speakingIndicators: googleSpeakingIndicators,
        peopleButtonSelectors: googlePeopleButtonSelectors
      } as any
    }
  );

  return {
    async start() {
      await page.evaluate(() => {
        return (window as any).__vexaSpeakerStart();
      });
    },
    async stop() {
      await page.evaluate(() => {
        return (window as any).__vexaSpeakerStop();
      });
    },
    getActiveParticipants(): string[] {
      return page.evaluate(() => {
        return (window as any).__vexaGetActiveParticipants();
      }) as any;
    },
    getActiveParticipantsCount(): number {
      return page.evaluate(() => {
        return (window as any).__vexaGetActiveParticipantsCount();
      }) as any;
    }
  };
}

