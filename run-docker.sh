#!/bin/bash
# Script to run the bot container with Docker volume for recordings

# Check if BOT_CONFIG is set
if [ -z "$BOT_CONFIG" ]; then
    echo "ERROR: BOT_CONFIG environment variable is not set"
    echo ""
    echo "Usage:"
    echo "  export BOT_CONFIG='{\"platform\":\"google_meet\",\"meetingUrl\":\"\",\"botName\":\"Test Bot\",\"meeting_id\":123,\"automaticLeave\":{\"waitingRoomTimeout\":300000,\"noOneJoinedTimeout\":600000,\"everyoneLeftTimeout\":120000}}'"
    echo "  ./run-docker.sh"
    echo ""
    exit 1
fi

# Create Docker volume for recordings if it doesn't exist
VOLUME_NAME="bot-recordings"
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    echo "Creating Docker volume: $VOLUME_NAME"
    docker volume create "$VOLUME_NAME"
fi

# Get the image name (you may need to adjust this)
IMAGE_NAME="${IMAGE_NAME:-bot-test}"

# Check if image exists, if not build it
if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    echo "Building Docker image..."
    docker build -t "$IMAGE_NAME" .
fi

# Run the container with Docker volume
echo "Starting bot container..."
echo "Recordings will be saved to Docker volume: $VOLUME_NAME"
echo "To extract recordings, use: docker run --rm -v $VOLUME_NAME:/data alpine tar -czf - -C /data . > recordings.tar.gz"
echo "Or copy files: docker run --rm -v $VOLUME_NAME:/data -v \$(pwd)/test-recordings:/output alpine cp -r /data /output"
docker run --rm \
    --name bot-test \
    -e BOT_CONFIG="$BOT_CONFIG" \
    -v "$VOLUME_NAME:/app/recordings" \
    --cap-add=SYS_ADMIN \
    --shm-size=2g \
    "$IMAGE_NAME"

