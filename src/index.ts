import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { log } from "./utils";
import { chromium } from "playwright-extra";
import { handleGoogleMeet, leaveGoogleMeet } from "./platforms/googlemeet";
// import { handleMicrosoftTeams, leaveMicrosoftTeams } from "./platforms/msteams";
import { browserArgs, userAgent } from "./constans";
import { BotConfig } from "./types";
import { Page, Browser } from 'playwright-core';

// Module-level variables to store current configuration
let currentPlatform: "google_meet" | "zoom" | "teams" | undefined;
let page: Page | null = null; // Initialize page, will be set in runBot

// --- ADDED: Flag to prevent multiple shutdowns ---
let isShuttingDown = false;
// ---------------------------------------------

// --- ADDED: Browser instance ---
let browserInstance: Browser | null = null;
// -------------------------------

// --- ADDED: Stop signal tracking ---
let stopSignalReceived = false;
export function hasStopSignalReceived(): boolean {
  return stopSignalReceived || isShuttingDown;
}
// -----------------------------------

// --- ADDED: Session Management Utilities ---
/**
 * Generate UUID for session identification
 */
export function generateUUID(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  } else {
    // Basic fallback if crypto.randomUUID is not available
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
      /[xy]/g,
      function (c) {
        var r = (Math.random() * 16) | 0,
          v = c == "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      }
    );
  }
}

/**
 * Get current timestamp in milliseconds
 */
export function getCurrentTimestamp(): number {
  return Date.now();
}

/**
 * Calculate relative timestamp from session start
 */
export function calculateRelativeTimestamp(sessionStartTimeMs: number | null): number | null {
  if (sessionStartTimeMs === null) {
    return null;
  }
  return Date.now() - sessionStartTimeMs;
}

/**
 * Create session control message
 */
export function createSessionControlMessage(
  event: string,
  sessionUid: string,
  botConfig: { token: string; platform: string; meeting_id: number; nativeMeetingId: string }
) {
  return {
    type: "session_control",
    payload: {
      event: event,
      uid: sessionUid,
      client_timestamp_ms: Date.now(),
      token: botConfig.token,  // MeetingToken (HS256 JWT)
      platform: botConfig.platform,
      meeting_id: botConfig.meeting_id
    }
  };
}

/**
 * Create speaker activity message
 */
export function createSpeakerActivityMessage(
  eventType: string,
  participantName: string,
  participantId: string,
  relativeTimestampMs: number,
  sessionUid: string,
  botConfig: { token: string; platform: string; meeting_id: number; nativeMeetingId: string; meetingUrl: string | null }
) {
  return {
    type: "speaker_activity",
    payload: {
      event_type: eventType,
      participant_name: participantName,
      participant_id_meet: participantId,
      relative_client_timestamp_ms: relativeTimestampMs,
      uid: sessionUid,
      token: botConfig.token,  // MeetingToken (HS256 JWT)
      platform: botConfig.platform,
      meeting_id: botConfig.meeting_id,
      meeting_url: botConfig.meetingUrl
    }
  };
}
// --- ------------------------------------ ---


// --- ADDED: Graceful Leave Function ---
async function performGracefulLeave(
  page: Page | null, // Allow page to be null for cases where it might not be available
  exitCode: number = 1, // Default to 1 (failure/generic error)
  reason: string = "self_initiated_leave", // Default reason
  errorDetails?: any // Optional detailed error information
): Promise<void> {
  if (isShuttingDown) {
    log("[Graceful Leave] Already in progress, ignoring duplicate call.");
    return;
  }
  isShuttingDown = true;
  log(`[Graceful Leave] Initiating graceful shutdown sequence... Reason: ${reason}, Exit Code: ${exitCode}`);

  let platformLeaveSuccess = false;
  if (page && !page.isClosed()) { // Only attempt platform leave if page is valid
    try {
      log("[Graceful Leave] Attempting platform-specific leave...");
      // Assuming currentPlatform is set appropriately, or determine it if needed
      if (currentPlatform === "google_meet") { // Add platform check if you have other platform handlers
         platformLeaveSuccess = await leaveGoogleMeet(page);
      } else if (currentPlatform === "teams") {
        //  platformLeaveSuccess = await leaveMicrosoftTeams(page);
      } else {
         log(`[Graceful Leave] No platform-specific leave defined for ${currentPlatform}. Page will be closed.`);
         // If no specific leave, we still consider it "handled" to proceed with cleanup.
         platformLeaveSuccess = true; // Or false if page closure itself is the "action"
      }
      log(`[Graceful Leave] Platform leave/close attempt result: ${platformLeaveSuccess}`);
      
      // If leave was successful, wait a bit longer before closing to ensure Teams processes the leave
      if (platformLeaveSuccess === true) {
        log("[Graceful Leave] Leave action successful. Waiting 2 more seconds before cleanup...");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (leaveError: any) {
      log(`[Graceful Leave] Error during platform leave/close attempt: ${leaveError.message}`);
      platformLeaveSuccess = false;
    }
  } else {
    log("[Graceful Leave] Page not available or already closed. Skipping platform-specific leave attempt.");
    // If the page is already gone, we can't perform a UI leave.
  }

  // Determine final exit code. If the initial intent was a successful exit (code 0),
  // it should always be 0. For error cases (non-zero exit codes), preserve the original error code.
  const finalExitCode = (exitCode === 0) ? 0 : exitCode;

  // Close the browser page if it's still open and wasn't closed by platform leave
  if (page && !page.isClosed()) {
    log("[Graceful Leave] Ensuring page is closed.");
    try {
      await page.close();
      log("[Graceful Leave] Page closed.");
    } catch (pageCloseError: any) {
      log(`[Graceful Leave] Error closing page: ${pageCloseError.message}`);
    }
  }

  // Close the browser instance
  log("[Graceful Leave] Closing browser instance...");
  try {
    if (browserInstance && browserInstance.isConnected()) {
       await browserInstance.close();
       log("[Graceful Leave] Browser instance closed.");
    } else {
       log("[Graceful Leave] Browser instance already closed or not available.");
    }
  } catch (browserCloseError: any) {
    log(`[Graceful Leave] Error closing browser: ${browserCloseError.message}`);
  }

  // Exit the process
  // The process exit code should reflect the overall success/failure.
  log(`[Graceful Leave] Exiting process with code ${finalExitCode} (Reason: ${reason}).`);
  process.exit(finalExitCode);
}
// --- ----------------------------- ---

// --- ADDED: Function to be called from browser to trigger leave ---
// This needs to be defined in a scope where 'page' will be available when it's exposed.
// We will define the actual exposed function inside runBot where 'page' is in scope.
// --- ------------------------------------------------------------ ---

export async function runBot(botConfig: BotConfig): Promise<void> {
  // --- UPDATED: Parse and store config values ---
  currentPlatform = botConfig.platform; // Set currentPlatform here

  // Destructure other needed config values
  const { meetingUrl, platform, botName } = botConfig;

  log(`Starting bot for ${platform} with URL: ${meetingUrl}, name: ${botName}`);

  // Simple browser setup like simple-bot.js
  if (botConfig.platform === "teams") {
    log("Using MS Edge browser for Teams platform (simple-bot.js approach)");
    // Launch browser in headless mode with Edge channel with insecure WebSocket support
    browserInstance = await chromium.launch({ 
      headless: false,
      channel: 'msedge',
      args: [
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--allow-running-insecure-content',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
        '--ignore-certificate-errors-spki-list',
        '--disable-site-isolation-trials',
        '--disable-features=VizDisplayCompositor'
      ]
    });
    
    // Create context with CSP bypass to allow script injection (like Google Meet)
    const context = await browserInstance.newContext({
      permissions: ['microphone', 'camera'],
      ignoreHTTPSErrors: true,
      bypassCSP: true
    });
    
    // Pre-inject browser utils before any page scripts (affects current + future navigations)
    try {
      await context.addInitScript({
        path: require('path').join(__dirname, 'browser-utils.global.js'),
      });
    } catch (e) {
      log(`Warning: context.addInitScript failed: ${(e as any)?.message || e}`);
    }
    
    page = await context.newPage();
  } else {
    log("Using Chrome browser for non-Teams platform");
    // Use Stealth Plugin for non-Teams platforms
    const stealthPlugin = StealthPlugin();
    stealthPlugin.enabledEvasions.delete("iframe.contentWindow");
    stealthPlugin.enabledEvasions.delete("media.codecs");
    chromium.use(stealthPlugin);

    browserInstance = await chromium.launch({
      headless: false,
      args: browserArgs,
    });

    // Create a new page with permissions and viewport for non-Teams
    const context = await browserInstance.newContext({
      permissions: ["camera", "microphone"],
      userAgent: userAgent,
      viewport: {
        width: 1280,
        height: 720
      }
    });
    
    page = await context.newPage();
  }

  // --- ADDED: Expose a function for browser to trigger Node.js graceful leave ---
  await page.exposeFunction("triggerNodeGracefulLeave", async () => {
    log("[Node.js] Received triggerNodeGracefulLeave from browser context.");
    if (!isShuttingDown) {
      await performGracefulLeave(page, 0, "self_initiated_leave_from_browser");
    } else {
      log("[Node.js] Ignoring triggerNodeGracefulLeave as shutdown is already in progress.");
    }
  });
  // --- ----------------------------------------------------------------------- ---

  // Setup anti-detection measures
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", {
      get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }],
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    Object.defineProperty(window, "innerWidth", { get: () => 1920 });
    Object.defineProperty(window, "innerHeight", { get: () => 1080 });
    Object.defineProperty(window, "outerWidth", { get: () => 1920 });
    Object.defineProperty(window, "outerHeight", { get: () => 1080 });
  });

  // Call the appropriate platform handler
  try {
    if (botConfig.platform === "google_meet") {

      await handleGoogleMeet(botConfig, page, performGracefulLeave);
    } else if (botConfig.platform === "zoom") {
      log("Zoom platform not yet implemented.");
      await performGracefulLeave(page, 1, "platform_not_implemented");
    } else if (botConfig.platform === "teams") {
      // await handleMicrosoftTeams(botConfig, page, performGracefulLeave);
    } else {
      log(`Unknown platform: ${botConfig.platform}`);
      await performGracefulLeave(page, 1, "unknown_platform");
    }
  } catch (error: any) {
    log(`Error during platform handling: ${error.message}`);
    await performGracefulLeave(page, 1, "platform_handler_exception");
  }

  // If we reached here without an explicit shutdown (e.g., admission failed path returned, or normal end),
  // force a graceful exit to ensure the container terminates cleanly.
  await performGracefulLeave(page, 0, "normal_completion");
}

// --- ADDED: Basic Signal Handling (for future Phase 5) ---
// Setup signal handling to also trigger graceful leave
const gracefulShutdown = async (signal: string) => {
    log(`Received signal: ${signal}. Triggering graceful shutdown.`);
    if (!isShuttingDown) {
        // Determine the correct page instance if multiple are possible, or use a global 'currentPage'
        // For now, assuming 'page' (if defined globally/module-scoped) or null
        const pageToClose = typeof page !== 'undefined' ? page : null;
        await performGracefulLeave(pageToClose, signal === 'SIGINT' ? 130 : 143, `signal_${signal.toLowerCase()}`);
    } else {
         log("[Signal Shutdown] Shutdown already in progress.");
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// --- ------------------------------------------------- ---
