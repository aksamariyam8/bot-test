#!/bin/bash
# Quick run script with inline BOT_CONFIG

VOLUME_NAME="bot-recordings"
IMAGE_NAME="bot-test"

# Create volume if it doesn't exist
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    echo "Creating Docker volume: $VOLUME_NAME"
    docker volume create "$VOLUME_NAME"
fi

# Run the container
docker run --rm \
  --shm-size=2g \
  --cap-add=SYS_ADMIN \
  -e BOT_CONFIG='{"platform":"google_meet","meetingUrl":"https://meet.google.com/vuc-qndv-nyu","botName":"Google Bot","meeting_id":1001,"automaticLeave":{"waitingRoomTimeout":300000,"noOneJoinedTimeout":600000,"everyoneLeftTimeout":120000}}' \
  -v "$VOLUME_NAME:/app/recordings" \
  "$IMAGE_NAME"

