#!/bin/bash
# Script to run the bot container with volume mount for recordings

# Check if BOT_CONFIG is set
if [ -z "$BOT_CONFIG" ]; then
    echo "ERROR: BOT_CONFIG environment variable is not set"
    echo ""
    echo "Usage:"
    echo "  export BOT_CONFIG='{\"platform\":\"google_meet\",\"meetingUrl\":\"https://meet.google.com/xxx-yyy-zzz\",\"botName\":\"Test Bot\",\"meeting_id\":123,\"automaticLeave\":{\"waitingRoomTimeout\":300000,\"noOneJoinedTimeout\":600000,\"everyoneLeftTimeout\":120000}}'"
    echo "  ./run-docker.sh"
    echo ""
    exit 1
fi

# Create test-recordings directory if it doesn't exist
mkdir -p ./test-recordings

# Ensure the directory has write permissions (fixes permission issues on some systems)
chmod 777 ./test-recordings 2>/dev/null || true

# Get the image name (you may need to adjust this)
IMAGE_NAME="${IMAGE_NAME:-bot-test}"

# Check if image exists, if not build it
if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    echo "Building Docker image..."
    docker build -t "$IMAGE_NAME" .
fi

# Run the container with volume mounts
echo "Starting bot container..."
echo "Recordings will be saved to: ./test-recordings"
echo "Note: If /home/bot-test is not writable, recordings will be saved to /tmp/bot-recordings (also mounted)"
docker run --rm \
    --name bot-test \
    -e BOT_CONFIG="$BOT_CONFIG" \
    -v "$(pwd)/test-recordings:/home/bot-test" \
    -v "$(pwd)/test-recordings:/tmp/bot-recordings" \
    --cap-add=SYS_ADMIN \
    --shm-size=2g \
    "$IMAGE_NAME"

