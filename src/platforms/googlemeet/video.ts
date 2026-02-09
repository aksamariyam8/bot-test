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
        // Use videoWidth/videoHeight if available, otherwise fall back to clientWidth/clientHeight or defaults
        const getVideoWidth = (v: HTMLVideoElement) => v.videoWidth || v.clientWidth || 640;
        const getVideoHeight = (v: HTMLVideoElement) => v.videoHeight || v.clientHeight || 480;
        
        const maxWidth = Math.max(...videos.map(getVideoWidth), 1920);
        const maxHeight = Math.max(...videos.map(getVideoHeight), 1080);
        canvas.width = maxWidth;
        canvas.height = maxHeight;

        (window as any).logBot(`Canvas size set to ${canvas.width}x${canvas.height} for ${videos.length} video element(s)`);

        // Create a stream from the canvas
        const canvasStream = canvas.captureStream(30); // 30 fps

        // Draw videos to canvas
        const drawVideos = () => {
          if (!ctx || !canvas) return;

          // Store references to avoid null checks in nested callbacks
          const canvasRef = canvas;
          const ctxRef = ctx;

          // Clear canvas
          ctxRef.fillStyle = '#000000';
          ctxRef.fillRect(0, 0, canvasRef.width, canvasRef.height);

          // Draw each video element
          videos.forEach((video, index) => {
            // Check if video is ready to be drawn (readyState >= 1 is enough, dimensions will be checked dynamically)
            if (video.readyState >= 1 && !video.paused) {
              // Get video dimensions, using fallbacks if not available yet
              const videoWidth = video.videoWidth || video.clientWidth || 640;
              const videoHeight = video.videoHeight || video.clientHeight || 480;
              
              // Only draw if we have some dimensions
              if (videoWidth > 0 && videoHeight > 0) {
                // Simple grid layout for multiple videos
                const cols = Math.ceil(Math.sqrt(videos.length));
                const rows = Math.ceil(videos.length / cols);
                const cellWidth = canvasRef.width / cols;
                const cellHeight = canvasRef.height / rows;
                const col = index % cols;
                const row = Math.floor(index / cols);
                
                const x = col * cellWidth;
                const y = row * cellHeight;
                const width = cellWidth;
                const height = cellHeight;

                try {
                  ctxRef.drawImage(video, x, y, width, height);
                } catch (error: any) {
                  // Silently skip if drawImage fails (video might not be ready yet)
                  // This is expected during initial frames
                }
              }
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

