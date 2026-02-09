import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { initializeAudioRecording, AudioRecordingService } from "./audio";
import { initializeVideoRecording, VideoRecordingService } from "./video";
import { initializeSpeakerDetection, SpeakerDetectionService } from "./speaker";
import * as fs from "fs";
import * as path from "path";

/**
 * Save blob from browser context to filesystem
 */
async function saveBlobToFile(
  page: Page,
  blobName: string,
  filePath: string
): Promise<void> {
  const base64Data = await page.evaluate(async (name: string) => {
    const blob = (window as any)[name];
    if (!blob) {
      return null;
    }
    return new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        // Remove data URL prefix (e.g., "data:audio/webm;base64,")
        const base64String = base64.split(',')[1] || base64;
        resolve(base64String);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }, blobName);

  if (!base64Data) {
    log(`Warning: No ${blobName} blob found to save`);
    return;
  }

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filePath, buffer);
  const fullPath = path.resolve(filePath);
  log(`✅ Saved ${blobName} to ${filePath}`);
  log(`   Full path: ${fullPath}`);
  log(`   Size: ${buffer.length} bytes (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  
  // Verify file exists
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    log(`   ✅ File verified: ${stats.size} bytes on disk`);
  } else {
    log(`   ⚠️ Warning: File not found after write!`);
  }
}

/**
 * Save speaker events to JSON file
 */
async function saveSpeakerEventsToFile(
  page: Page,
  filePath: string
): Promise<void> {
  const events = await page.evaluate(() => {
    return (window as any).__vexaSpeakerEvents || [];
  });

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write JSON file
  fs.writeFileSync(filePath, JSON.stringify(events, null, 2));
  const fullPath = path.resolve(filePath);
  log(`✅ Saved speaker events to ${filePath}`);
  log(`   Full path: ${fullPath}`);
  log(`   Events: ${events.length}`);
  
  // Verify file exists
  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    log(`   ✅ File verified: ${stats.size} bytes on disk`);
  } else {
    log(`   ⚠️ Warning: File not found after write!`);
  }
}

export async function startGoogleRecording(page: Page, botConfig: BotConfig): Promise<void> {
  log("Starting Google Meet recording (audio, video, and speaker detection)");

  // Generate unique recording ID based on meeting ID and timestamp
  const meetingId = (botConfig as any).meeting_id || 'unknown';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recordingId = `meeting-${meetingId}-${timestamp}`;
  const recordingsDir = '/home/bot-test';
  const recordingDir = path.join(recordingsDir, recordingId);

  // Ensure recordings directory exists
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
    log(`Created recordings directory: ${recordingsDir}`);
  }
  if (!fs.existsSync(recordingDir)) {
    fs.mkdirSync(recordingDir, { recursive: true });
    log(`Created recording directory: ${recordingDir}`);
  }

  log(`📁 Recording files will be saved to: ${recordingDir}`);
  log(`📁 Full path: ${path.resolve(recordingDir)}`);
  log(`📁 Files will be:`);
  log(`   - ${path.join(recordingDir, 'audio.webm')}`);
  log(`   - ${path.join(recordingDir, 'video.webm')}`);
  log(`   - ${path.join(recordingDir, 'speaker-events.json')}`);

  // Initialize all recording services
  const audioService = await initializeAudioRecording(page, botConfig);
  const videoService = await initializeVideoRecording(page, botConfig);
  const speakerService = await initializeSpeakerDetection(page, botConfig);

  // Start all recording services
  await Promise.all([
    audioService.start(),
    videoService.start(),
    speakerService.start()
  ]);

  log("All recording services started successfully");

  // Setup meeting monitoring
  await page.evaluate(
    async (pageArgs: {
      botConfigData: BotConfig;
    }) => {
      const { botConfigData } = pageArgs;

      const leaveCfg = (botConfigData && (botConfigData as any).automaticLeave) || {};
      const startupAloneTimeoutSeconds = Number(leaveCfg.startupAloneTimeoutSeconds ?? (20 * 60));
      const everyoneLeftTimeoutSeconds = Number(leaveCfg.everyoneLeftTimeoutSeconds ?? 10);

      let aloneTime = 0;
      let lastParticipantCount = 0;
      let speakersIdentified = false;
      let hasEverHadMultipleParticipants = false;

      const checkInterval = setInterval(() => {
        // Check participant count using the speaker service helper
        const currentParticipantCount = (window as any).__vexaGetActiveParticipantsCount 
          ? (window as any).__vexaGetActiveParticipantsCount() 
          : 0;

        if (currentParticipantCount !== lastParticipantCount) {
          (window as any).logBot(`Participant check: Found ${currentParticipantCount} unique participants from central list.`);
          lastParticipantCount = currentParticipantCount;

          // Track if we've ever had multiple participants
          if (currentParticipantCount > 1) {
            hasEverHadMultipleParticipants = true;
            speakersIdentified = true;
            (window as any).logBot("Speakers identified - switching to post-speaker monitoring mode");
          }
        }

        if (currentParticipantCount <= 1) {
          aloneTime++;

          // Determine timeout based on whether speakers have been identified
          const currentTimeout = speakersIdentified ? everyoneLeftTimeoutSeconds : startupAloneTimeoutSeconds;
          const timeoutDescription = speakersIdentified ? "post-speaker" : "startup";

          if (aloneTime >= currentTimeout) {
            if (speakersIdentified) {
              (window as any).logBot(`Google Meet meeting ended or bot has been alone for ${everyoneLeftTimeoutSeconds} seconds after speakers were identified. Stopping recorder...`);
              clearInterval(checkInterval);
              (window as any).__vexaAudioStop?.();
              (window as any).__vexaVideoStop?.();
              (window as any).__vexaSpeakerStop?.();
              // Reject will be handled by the promise wrapper
              (window as any).__vexaRecordingRejected = new Error("GOOGLE_MEET_BOT_LEFT_ALONE_TIMEOUT");
            } else {
              (window as any).logBot(`Google Meet bot has been alone for ${startupAloneTimeoutSeconds/60} minutes during startup with no other participants. Stopping recorder...`);
              clearInterval(checkInterval);
              (window as any).__vexaAudioStop?.();
              (window as any).__vexaVideoStop?.();
              (window as any).__vexaSpeakerStop?.();
              (window as any).__vexaRecordingRejected = new Error("GOOGLE_MEET_BOT_STARTUP_ALONE_TIMEOUT");
            }
          } else if (aloneTime > 0 && aloneTime % 10 === 0) {
            if (speakersIdentified) {
              (window as any).logBot(`Bot has been alone for ${aloneTime} seconds (${timeoutDescription} mode). Will leave in ${currentTimeout - aloneTime} more seconds.`);
            } else {
              const remainingMinutes = Math.floor((currentTimeout - aloneTime) / 60);
              const remainingSeconds = (currentTimeout - aloneTime) % 60;
              (window as any).logBot(`Bot has been alone for ${aloneTime} seconds during startup. Will leave in ${remainingMinutes}m ${remainingSeconds}s.`);
            }
          }
        } else {
          aloneTime = 0;
          if (hasEverHadMultipleParticipants && !speakersIdentified) {
            speakersIdentified = true;
            (window as any).logBot("Speakers identified - switching to post-speaker monitoring mode");
          }
        }
      }, 1000);

      // Listen for page unload
      window.addEventListener("beforeunload", () => {
        (window as any).logBot("Page is unloading. Stopping recorder...");
        clearInterval(checkInterval);
        (window as any).__vexaAudioStop?.();
        (window as any).__vexaVideoStop?.();
        (window as any).__vexaSpeakerStop?.();
        (window as any).__vexaRecordingResolved = true;
      });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          (window as any).logBot("Document is hidden. Stopping recorder...");
          clearInterval(checkInterval);
          (window as any).__vexaAudioStop?.();
          (window as any).__vexaVideoStop?.();
          (window as any).__vexaSpeakerStop?.();
          (window as any).__vexaRecordingResolved = true;
        }
      });

      // Store interval for cleanup
      (window as any).__vexaRecordingInterval = checkInterval;
    },
    { botConfigData: botConfig }
  );

  // Wait for recording to complete or error
  return new Promise<void>((resolve, reject) => {
    const checkStatus = setInterval(async () => {
      const status = await page.evaluate(() => {
        if ((window as any).__vexaRecordingRejected) {
          return { type: 'rejected', error: (window as any).__vexaRecordingRejected };
        }
        if ((window as any).__vexaRecordingResolved) {
          return { type: 'resolved' };
        }
        return { type: 'pending' };
      });

      if (status.type === 'rejected') {
        clearInterval(checkStatus);
        // Stop all services
        try {
          await audioService.stop();
          await videoService.stop();
          await speakerService.stop();
          
          // Save recording files
          await saveBlobToFile(page, '__vexaAudioBlob', path.join(recordingDir, 'audio.webm'));
          await saveBlobToFile(page, '__vexaVideoBlob', path.join(recordingDir, 'video.webm'));
          await saveSpeakerEventsToFile(page, path.join(recordingDir, 'speaker-events.json'));
        } catch (e) {
          log(`Error stopping services or saving files: ${e}`);
        }
        reject(status.error);
      } else if (status.type === 'resolved') {
        clearInterval(checkStatus);
        // Stop all services
        try {
          await audioService.stop();
          await videoService.stop();
          await speakerService.stop();
          
          // Save recording files
          await saveBlobToFile(page, '__vexaAudioBlob', path.join(recordingDir, 'audio.webm'));
          await saveBlobToFile(page, '__vexaVideoBlob', path.join(recordingDir, 'video.webm'));
          await saveSpeakerEventsToFile(page, path.join(recordingDir, 'speaker-events.json'));
          
          log(`✅ All recording files saved to: ${recordingDir}`);
          log(`📁 Full directory path: ${path.resolve(recordingDir)}`);
          
          // List all files in the directory
          try {
            const files = fs.readdirSync(recordingDir);
            log(`📁 Files in recording directory:`);
            files.forEach(file => {
              const filePath = path.join(recordingDir, file);
              const stats = fs.statSync(filePath);
              log(`   - ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            });
          } catch (e) {
            log(`⚠️ Could not list files in directory: ${e}`);
          }
        } catch (e) {
          log(`Error stopping services or saving files: ${e}`);
        }
        resolve();
      }
    }, 1000);
  });
}

