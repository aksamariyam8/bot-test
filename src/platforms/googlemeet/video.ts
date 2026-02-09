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
          // Get all video elements
          const allVideos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
          (window as any).logBot(`[Video] Attempt ${i + 1}/${maxRetries}: Found ${allVideos.length} total video elements in DOM`);
          
          // Filter for active video elements with proper checks (similar to audio service)
          const activeVideos = allVideos.filter((v: any) => {
            // Check if element has srcObject
            if (!v.srcObject) {
              return false;
            }
            
            // Check if srcObject is a MediaStream
            if (!(v.srcObject instanceof MediaStream)) {
              return false;
            }
            
            // Check if MediaStream has video tracks
            const videoTracks = v.srcObject.getVideoTracks();
            if (videoTracks.length === 0) {
              return false;
            }
            
            // Check if element is not paused
            if (v.paused) {
              (window as any).logBot(`[Video] Element found but is paused (readyState: ${v.readyState})`);
              return false;
            }
            
            // Check readyState - prefer elements that have loaded metadata or more
            // 0 = HAVE_NOTHING, 1 = HAVE_METADATA, 2 = HAVE_CURRENT_DATA, 3 = HAVE_FUTURE_DATA, 4 = HAVE_ENOUGH_DATA
            if (v.readyState < 1) {
              (window as any).logBot(`[Video] Element found but readyState is ${v.readyState} (HAVE_NOTHING)`);
              return false;
            }
            
            // Check if video tracks are enabled
            const hasEnabledTracks = videoTracks.some((track: MediaStreamTrack) => track.enabled && !track.muted);
            if (!hasEnabledTracks) {
              (window as any).logBot(`[Video] Element found but all video tracks are disabled or muted`);
              return false;
            }
            
            return true;
          });

          if (activeVideos.length > 0) {
            (window as any).logBot(`✅ Found ${activeVideos.length} active video element(s) with video tracks after ${i + 1} attempt(s).`);
            // Log details about found elements
            activeVideos.forEach((v: any, idx: number) => {
              const tracks = v.srcObject.getVideoTracks();
              (window as any).logBot(`  Element ${idx + 1}: paused=${v.paused}, readyState=${v.readyState}, tracks=${tracks.length}, enabled=${tracks.filter((t: MediaStreamTrack) => t.enabled).length}, dimensions=${v.videoWidth}x${v.videoHeight}`);
            });
            return activeVideos;
          }
          
          // Enhanced diagnostic logging
          if (allVideos.length > 0) {
            (window as any).logBot(`[Video] Found ${allVideos.length} video elements but none are active. Details:`);
            allVideos.forEach((v: any, idx: number) => {
              const hasSrcObject = !!v.srcObject;
              const isMediaStream = v.srcObject instanceof MediaStream;
              const videoTracks = isMediaStream ? v.srcObject.getVideoTracks().length : 0;
              (window as any).logBot(`  Element ${idx + 1}: paused=${v.paused}, readyState=${v.readyState}, hasSrcObject=${hasSrcObject}, isMediaStream=${isMediaStream}, videoTracks=${videoTracks}, dimensions=${v.videoWidth}x${v.videoHeight}`);
            });
          } else {
            (window as any).logBot(`[Video] No video elements found in DOM at all`);
          }

          if (i < maxRetries - 1) {
            (window as any).logBot(`[Video] Retrying in ${delayMs}ms... (Attempt ${i + 2}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
        }
        
        (window as any).logBot(`❌ No active video elements found after ${maxRetries} attempts`);
        return [];
      };

      const captureVideoStream = async (): Promise<MediaStream> => {
        (window as any).logBot("[Video] Attempting to capture screen using getDisplayMedia API...");
        
        try {
          // Use getDisplayMedia to capture the entire screen/tab
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              displaySurface: 'browser', // or 'window' or 'screen'
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30 }
            },
            audio: false // We're only capturing video here, audio is handled separately
          });

          (window as any).logBot("[Video] Successfully obtained display media stream");
          
          // Return the video track from the display stream
          const videoTracks = displayStream.getVideoTracks();
          if (videoTracks.length === 0) {
            throw new Error("[Google Meet Video Error] No video tracks in display media stream");
          }

          (window as any).logBot(`[Video] Found ${videoTracks.length} video track(s) in display stream`);
          
          // Create a new MediaStream with just the video track
          const videoStream = new MediaStream(videoTracks);
          
          return videoStream;
        } catch (error: any) {
          (window as any).logBot(`[Video] getDisplayMedia failed: ${error.message}`);
          (window as any).logBot("[Video] Falling back to canvas-based DOM recording...");
          
          // Fallback: Record the entire page using canvas
          return capturePageAsCanvas();
        }
      };

      const capturePageAsCanvas = (): MediaStream => {
        (window as any).logBot("[Video] Capturing entire page using canvas...");
        
        // Create canvas matching viewport size
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error("[Google Meet Video Error] Failed to create canvas context");
        }

        // Set canvas size to match viewport
        canvas.width = window.innerWidth || 1920;
        canvas.height = window.innerHeight || 1080;

        (window as any).logBot(`[Video] Canvas size set to ${canvas.width}x${canvas.height} (viewport size)`);

        // Create a stream from the canvas
        const canvasStream = canvas.captureStream(30); // 30 fps

        // Draw entire page to canvas using html2canvas-like approach
        const drawPage = async () => {
          if (!ctx || !canvas) return;

          const canvasRef = canvas;
          const ctxRef = ctx;

          try {
            // Clear canvas
            ctxRef.fillStyle = '#ffffff';
            ctxRef.fillRect(0, 0, canvasRef.width, canvasRef.height);

            // Try to draw the entire document body
            // Note: This is a simplified approach - for better results, consider using html2canvas library
            const body = document.body;
            if (body) {
              // Draw all video elements if they exist
              const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
              videos.forEach((video, index) => {
                if (video.readyState >= 1 && !video.paused) {
                  try {
                    const rect = video.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                      ctxRef.drawImage(video, rect.left, rect.top, rect.width, rect.height);
                    }
                  } catch (e) {
                    // Skip if drawImage fails
                  }
                }
              });

              // Draw any canvas elements
              const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
              canvases.forEach((canvasEl) => {
                try {
                  const rect = canvasEl.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    ctxRef.drawImage(canvasEl, rect.left, rect.top, rect.width, rect.height);
                  }
                } catch (e) {
                  // Skip if drawImage fails
                }
              });
            }
          } catch (error: any) {
            (window as any).logBot(`[Video] Error drawing page: ${error.message}`);
          }

          animationFrameId = requestAnimationFrame(drawPage);
        };

        // Start drawing loop
        drawPage();

        return canvasStream;
      };

      const startRecording = async () => {
        try {
          (window as any).logBot("Starting video recording...");
          (window as any).logBot("[Video] Recording entire page/screen - no waiting for video elements");

          // No wait needed - start recording immediately
          // Capture video stream (screen capture or canvas fallback)
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

