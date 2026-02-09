import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { ensureBrowserUtils } from "../../utils/injection";

export interface VideoRecordingService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function initializeVideoRecording(
  page: Page,
  botConfig: BotConfig
): Promise<VideoRecordingService> {
  await ensureBrowserUtils(page, require('path').join(__dirname, '../../browser-utils.global.js'));

  const videoServiceHandle = await page.evaluate(
    async (pageArgs: { botConfigData: BotConfig }) => {
      const { botConfigData } = pageArgs;

      (window as any).logBot("Initializing video recording...");

      // Store video chunks for recording
      const videoChunks: Blob[] = [];
      let mediaRecorder: MediaRecorder | null = null;
      let videoStream: MediaStream | null = null;
      let canvas: HTMLCanvasElement | null = null;
      let ctx: CanvasRenderingContext2D | null = null;
      let animationFrameId: number | null = null;

      const findVideoElements = async (maxRetries: number = 10, delayMs: number = 3000): Promise<HTMLVideoElement[]> => {
        for (let i = 0; i < maxRetries; i++) {
          const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
          const activeVideos = videos.filter(v => 
            v.readyState >= 2 && 
            !v.paused && 
            v.videoWidth > 0 && 
            v.videoHeight > 0
          );

          if (activeVideos.length > 0) {
            (window as any).logBot(`Found ${activeVideos.length} active video element(s)`);
            return activeVideos;
          }

          if (i < maxRetries - 1) {
            (window as any).logBot(`No active video elements found, retrying in ${delayMs}ms... (${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
        return [];
      };

      const captureVideoStream = async (): Promise<MediaStream> => {
        const videos = await findVideoElements(10, 3000);
        
        if (videos.length === 0) {
          throw new Error(
            "[Google Meet Video Error] No active video elements found after multiple retries."
          );
        }

        // Create canvas to combine multiple video streams
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error("[Google Meet Video Error] Failed to create canvas context");
        }

        // Set canvas size to match the largest video or use a standard size
        const maxWidth = Math.max(...videos.map(v => v.videoWidth), 1920);
        const maxHeight = Math.max(...videos.map(v => v.videoHeight), 1080);
        canvas.width = maxWidth;
        canvas.height = maxHeight;

        // Create a stream from the canvas
        const canvasStream = canvas.captureStream(30); // 30 fps

        // Draw videos to canvas
        const drawVideos = () => {
          if (!ctx || !canvas) return;

          // Clear canvas
          ctx.fillStyle = '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Draw each video element
          videos.forEach((video, index) => {
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
              // Simple grid layout for multiple videos
              const cols = Math.ceil(Math.sqrt(videos.length));
              const rows = Math.ceil(videos.length / cols);
              const cellWidth = canvas.width / cols;
              const cellHeight = canvas.height / rows;
              const col = index % cols;
              const row = Math.floor(index / cols);
              
              const x = col * cellWidth;
              const y = row * cellHeight;
              const width = cellWidth;
              const height = cellHeight;

              ctx.drawImage(video, x, y, width, height);
            }
          });

          animationFrameId = requestAnimationFrame(drawVideos);
        };

        // Start drawing loop
        drawVideos();

        return canvasStream;
      };

      const startRecording = async () => {
        try {
          (window as any).logBot("Starting video recording...");

          // Wait 2 seconds for video elements to initialize
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Capture video stream from canvas
          videoStream = await captureVideoStream();

          // Setup MediaRecorder for video recording
          const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
            ? 'video/webm;codecs=vp8'
            : MediaRecorder.isTypeSupported('video/webm')
            ? 'video/webm'
            : MediaRecorder.isTypeSupported('video/mp4')
            ? 'video/mp4'
            : 'video/webm'; // fallback

          mediaRecorder = new MediaRecorder(videoStream, {
            mimeType: mimeType,
            videoBitsPerSecond: 2500000 // 2.5 Mbps
          });

          videoChunks.length = 0; // Clear previous chunks

          mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              videoChunks.push(event.data);
            }
          };

          mediaRecorder.onstop = () => {
            (window as any).logBot(`Video recording stopped. Total chunks: ${videoChunks.length}`);
            if (animationFrameId !== null) {
              cancelAnimationFrame(animationFrameId);
              animationFrameId = null;
            }
          };

          mediaRecorder.onerror = (event) => {
            (window as any).logBot(`Video recording error: ${(event as any).error?.message || 'Unknown error'}`);
          };

          // Start recording
          mediaRecorder.start(1000); // Collect data every second
          (window as any).logBot("Video recording started successfully.");

        } catch (error: any) {
          (window as any).logBot(`[Video Recording Error] ${error.message}`);
          throw error;
        }
      };

      const stopRecording = async () => {
        try {
          (window as any).logBot("Stopping video recording...");
          
          if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
          }

          if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
          }

          // Stop all tracks
          if (videoStream) {
            videoStream.getTracks().forEach(track => track.stop());
          }

          // Return video blob if needed
          if (videoChunks.length > 0) {
            const videoBlob = new Blob(videoChunks, { type: mediaRecorder?.mimeType || 'video/webm' });
            (window as any).logBot(`Video recording completed. Blob size: ${videoBlob.size} bytes`);
            // Store blob globally if needed for download
            (window as any).__vexaVideoBlob = videoBlob;
          }

          // Cleanup canvas
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
            canvas = null;
            ctx = null;
          }

        } catch (error: any) {
          (window as any).logBot(`[Video Stop Error] ${error.message}`);
        }
      };

      // Expose methods globally
      (window as any).__vexaVideoStart = startRecording;
      (window as any).__vexaVideoStop = stopRecording;

      return {
        start: startRecording,
        stop: stopRecording
      };
    },
    { botConfigData: botConfig }
  );

  return {
    async start() {
      await page.evaluate(() => {
        return (window as any).__vexaVideoStart();
      });
    },
    async stop() {
      await page.evaluate(() => {
        return (window as any).__vexaVideoStop();
      });
    }
  };
}

