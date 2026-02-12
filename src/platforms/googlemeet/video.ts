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
        (window as any).logBot("[Video] Note: getDisplayMedia requires user interaction and may not work in automated environments");
        
        try {
          // Check if getDisplayMedia is available
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new Error("getDisplayMedia API not available");
          }
          
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
          (window as any).logBot(`[Video] getDisplayMedia failed: ${error.name} - ${error.message}`);
          (window as any).logBot("[Video] This is expected in automated/headless environments");
          (window as any).logBot("[Video] Falling back to canvas-based video element capture...");
          
          // Fallback: Record video elements using canvas
          return capturePageAsCanvas();
        }
      };

      const capturePageAsCanvas = (): MediaStream => {
        (window as any).logBot("[Video] Capturing page using canvas with video element capture...");
        
        // Find video elements first
        const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
        const activeVideos = videos.filter(v => 
          v.readyState >= 2 && 
          !v.paused && 
          v.videoWidth > 0 && 
          v.videoHeight > 0 &&
          v.offsetWidth > 0 &&
          v.offsetHeight > 0
        );
        
        (window as any).logBot(`[Video] Found ${videos.length} total video elements, ${activeVideos.length} are active`);
        
        if (activeVideos.length === 0) {
          (window as any).logBot(`[Video] Warning: No active video elements found. Will create blank canvas stream.`);
          videos.forEach((v, idx) => {
            (window as any).logBot(`  Video ${idx + 1}: paused=${v.paused}, readyState=${v.readyState}, dimensions=${v.videoWidth}x${v.videoHeight}, visible=${v.offsetWidth > 0 && v.offsetHeight > 0}, hasSrcObject=${!!v.srcObject}`);
          });
        }
        
        // Create canvas matching viewport size
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { 
          willReadFrequently: true,
          alpha: false 
        });
        if (!ctx) {
          throw new Error("[Google Meet Video Error] Failed to create canvas context");
        }

        // Set canvas size to match viewport
        canvas.width = window.innerWidth || 1920;
        canvas.height = window.innerHeight || 1080;

        (window as any).logBot(`[Video] Canvas size set to ${canvas.width}x${canvas.height} (viewport size)`);

        // Create a stream from the canvas
        const canvasStream = canvas.captureStream(30); // 30 fps

        let frameCount = 0;
        let lastVideoDrawn = false;

        // Draw page content to canvas
        const drawPage = () => {
          if (!ctx || !canvas) return;

          const canvasRef = canvas;
          const ctxRef = ctx;
          frameCount++;

          try {
            // Clear canvas with black background
            ctxRef.fillStyle = '#000000';
            ctxRef.fillRect(0, 0, canvasRef.width, canvasRef.height);

            // Find and draw all video elements (these contain the actual meeting video)
            const currentVideos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
            let videoDrawn = false;
            
            currentVideos.forEach((video) => {
              try {
                // Check if video is playing and has content
                if (video.readyState >= 2 && !video.paused && video.videoWidth > 0 && video.videoHeight > 0) {
                  const rect = video.getBoundingClientRect();
                  
                  // Only draw if video is visible and has dimensions
                  if (rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0) {
                    // Scale video to fit canvas while maintaining aspect ratio
                    const videoAspect = video.videoWidth / video.videoHeight;
                    const canvasAspect = canvasRef.width / canvasRef.height;
                    
                    let drawWidth, drawHeight, drawX, drawY;
                    
                    if (videoAspect > canvasAspect) {
                      // Video is wider - fit to width
                      drawWidth = canvasRef.width;
                      drawHeight = canvasRef.width / videoAspect;
                      drawX = 0;
                      drawY = (canvasRef.height - drawHeight) / 2;
                    } else {
                      // Video is taller - fit to height
                      drawHeight = canvasRef.height;
                      drawWidth = canvasRef.height * videoAspect;
                      drawX = (canvasRef.width - drawWidth) / 2;
                      drawY = 0;
                    }
                    
                    // Draw video centered on canvas
                    ctxRef.drawImage(video, drawX, drawY, drawWidth, drawHeight);
                    videoDrawn = true;
                  }
                }
              } catch (e: any) {
                // Skip if drawImage fails (CORS or other issues)
              }
            });

            // Log periodically if no video is being drawn
            if (!videoDrawn && frameCount % 300 === 0) { // Every 10 seconds at 30fps
              (window as any).logBot(`[Video] Still no video elements to draw after ${frameCount} frames. Found ${currentVideos.length} video elements.`);
              currentVideos.forEach((v, idx) => {
                (window as any).logBot(`  Video ${idx + 1}: paused=${v.paused}, readyState=${v.readyState}, dimensions=${v.videoWidth}x${v.videoHeight}, visible=${v.offsetWidth > 0 && v.offsetHeight > 0}`);
              });
            }
            
            if (videoDrawn && !lastVideoDrawn) {
              (window as any).logBot(`[Video] ✅ Started drawing video content to canvas`);
            }
            lastVideoDrawn = videoDrawn;

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
          
          // Wait a bit for video elements to initialize after joining meeting
          (window as any).logBot("[Video] Waiting 3 seconds for video elements to initialize...");
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Check for video elements before starting
          const videos = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
          (window as any).logBot(`[Video] Found ${videos.length} video element(s) in DOM`);
          
          if (videos.length > 0) {
            videos.forEach((v, idx) => {
              (window as any).logBot(`  Video ${idx + 1}: paused=${v.paused}, readyState=${v.readyState}, dimensions=${v.videoWidth}x${v.videoHeight}, hasSrcObject=${!!v.srcObject}`);
            });
          }

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

