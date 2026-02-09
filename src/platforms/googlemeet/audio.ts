import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { ensureBrowserUtils } from "../../utils/injection";

export interface AudioRecordingService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSessionStartTime(): number | null;
}

export async function initializeAudioRecording(
  page: Page,
  botConfig: BotConfig
): Promise<AudioRecordingService> {
  await ensureBrowserUtils(page, require('path').join(__dirname, '../../browser-utils.global.js'));

  const audioServiceHandle = await page.evaluate(
    async (pageArgs: { botConfigData: BotConfig }) => {
      const { botConfigData } = pageArgs;

      // Use browser utility classes from the global bundle
      const browserUtils = (window as any).VexaBrowserUtils;
      (window as any).logBot(`Browser utils available: ${Object.keys(browserUtils || {}).join(', ')}`);

      const audioService = new browserUtils.BrowserAudioService({
        targetSampleRate: 16000,
        bufferSize: 4096,
        inputChannels: 1,
        outputChannels: 1
      });

      // Expose audio service globally
      (window as any).__vexaAudioService = audioService;
      (window as any).__vexaBotConfig = botConfigData;

      // Store audio chunks for recording
      const audioChunks: Blob[] = [];
      let mediaRecorder: MediaRecorder | null = null;
      let combinedStream: MediaStream | null = null;
      let sessionStartTime: number | null = null;

      const startRecording = async () => {
        try {
          (window as any).logBot("Starting audio recording...");

          // Wait 2 seconds for media elements to initialize after admission
          (window as any).logBot("Waiting 2 seconds for media elements to initialize after admission...");
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Find media elements with retry logic
          const mediaElements = await audioService.findMediaElements(10, 3000);
          if (mediaElements.length === 0) {
            throw new Error(
              "[Google Meet Audio Error] No active media elements found after multiple retries. Ensure the Google Meet meeting media is playing."
            );
          }

          // Create combined audio stream
          combinedStream = await audioService.createCombinedAudioStream(mediaElements);
          if (!combinedStream) {
            throw new Error("[Google Meet Audio Error] Failed to create combined audio stream");
          }

          // Setup MediaRecorder for audio recording directly from the stream
          const mimeType = MediaRecorder.isTypeSupported('audio/webm') 
            ? 'audio/webm' 
            : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : 'audio/webm'; // fallback

          mediaRecorder = new MediaRecorder(combinedStream, {
            mimeType: mimeType
          });

          audioChunks.length = 0; // Clear previous chunks

          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              audioChunks.push(event.data);
            }
          };

          mediaRecorder.onstop = () => {
            (window as any).logBot(`Audio recording stopped. Total chunks: ${audioChunks.length}`);
          };

          mediaRecorder.onerror = (event) => {
            (window as any).logBot(`Audio recording error: ${(event as any).error?.message || 'Unknown error'}`);
          };

          // Start recording
          sessionStartTime = Date.now();
          mediaRecorder.start(1000); // Collect data every second
          (window as any).logBot("Audio recording started successfully.");

          // Store session start time in audio service for speaker detection compatibility
          const processor = (audioService as any).processor;
          if (processor) {
            processor.sessionAudioStartTimeMs = sessionStartTime;
          }

        } catch (error: any) {
          (window as any).logBot(`[Audio Recording Error] ${error.message}`);
          throw error;
        }
      };

      const stopRecording = async () => {
        try {
          (window as any).logBot("Stopping audio recording...");
          
          if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
          }

          audioService.disconnect();

          // Return audio blob if needed
          if (audioChunks.length > 0) {
            const audioBlob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
            (window as any).logBot(`Audio recording completed. Blob size: ${audioBlob.size} bytes`);
            // Store blob globally if needed for download
            (window as any).__vexaAudioBlob = audioBlob;
          }
        } catch (error: any) {
          (window as any).logBot(`[Audio Stop Error] ${error.message}`);
        }
      };

      const getSessionStartTime = () => {
        return sessionStartTime;
      };

      // Expose methods globally
      (window as any).__vexaAudioStart = startRecording;
      (window as any).__vexaAudioStop = stopRecording;
      (window as any).__vexaAudioGetSessionStartTime = getSessionStartTime;

      return {
        start: startRecording,
        stop: stopRecording,
        getSessionStartTime: getSessionStartTime
      };
    },
    { botConfigData: botConfig }
  );

  return {
    async start() {
      await page.evaluate(() => {
        return (window as any).__vexaAudioStart();
      });
    },
    async stop() {
      await page.evaluate(() => {
        return (window as any).__vexaAudioStop();
      });
    },
    getSessionStartTime(): number | null {
      return page.evaluate(() => {
        return (window as any).__vexaAudioGetSessionStartTime();
      }) as any;
    }
  };
}

