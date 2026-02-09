import { runBot } from "."
import { z } from 'zod';
import { BotConfig } from "./types"; // Import the BotConfig type

// Define a schema that matches your JSON configuration
export const BotConfigSchema = z.object({
  platform: z.enum(["google_meet", "zoom", "teams"]),
  meetingUrl: z.string().url().nullable(), // Allow null from BOT_CONFIG
  botName: z.string(),    
  container_name: z.string().optional(), // ADDED: Optional container name
  meeting_id: z.number().int(), // Required meeting ID
  automaticLeave: z.object({
    waitingRoomTimeout: z.number().int(),
    noOneJoinedTimeout: z.number().int(),
    everyoneLeftTimeout: z.number().int()
  }),
});


(function main() {
const rawConfig = process.env.BOT_CONFIG;
console.log("[DEBUG] BOT_CONFIG value:", rawConfig ? "SET" : "NOT SET");
console.log("[DEBUG] All env vars with BOT:", Object.keys(process.env).filter(k => k.includes('BOT')));

if (!rawConfig) {
  console.error("BOT_CONFIG environment variable is not set");
  console.error("Please set it using: $env:BOT_CONFIG = '{\"platform\":\"...\", ...}'");
  process.exit(1);
}

  try {
  // Parse the JSON string from the environment variable
  const parsedConfig = JSON.parse(rawConfig);
  // Validate and parse the config using zod
  const botConfig: BotConfig = BotConfigSchema.parse(parsedConfig) as BotConfig;

  // Debug: Show parsed config values
  console.log("[DEBUG] Parsed Config Values:");
  console.log("[DEBUG]   Platform:", botConfig.platform);
  console.log("[DEBUG]   Meeting URL:", botConfig.meetingUrl);
  console.log("[DEBUG]   Bot Name:", botConfig.botName);
  console.log("[DEBUG]   Container Name:", botConfig.container_name || "(not set)");
  console.log("[DEBUG]   Meeting ID:", botConfig.meeting_id);
  console.log("[DEBUG]   Automatic Leave:");
  console.log("[DEBUG]     - Waiting Room Timeout:", botConfig.automaticLeave.waitingRoomTimeout);
  console.log("[DEBUG]     - No One Joined Timeout:", botConfig.automaticLeave.noOneJoinedTimeout);
  console.log("[DEBUG]     - Everyone Left Timeout:", botConfig.automaticLeave.everyoneLeftTimeout);

  // Run the bot with the validated configuration
  runBot(botConfig).catch((error) => {
    console.error("Error running bot:", error);
    process.exit(1);
  });
} catch (error) {
  console.error("Invalid BOT_CONFIG:", error);
  process.exit(1);
}
})()
