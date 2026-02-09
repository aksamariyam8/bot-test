export type BotConfig = {
  platform: "google_meet" | "zoom" | "teams",
  meetingUrl: string | null,
  botName: string,
  container_name?: string,
  automaticLeave: {
    waitingRoomTimeout: number,
    noOneJoinedTimeout: number,
    everyoneLeftTimeout: number
  },
  meeting_id: number,  // Required, not optional
}
