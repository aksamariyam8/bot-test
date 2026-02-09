#!/bin/bash
# Script to extract recordings from Docker volume to local directory

VOLUME_NAME="bot-recordings"
OUTPUT_DIR="./test-recordings"

# Check if volume exists
if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
    echo "ERROR: Docker volume '$VOLUME_NAME' does not exist"
    echo "Run the bot first to create recordings"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo "Extracting recordings from Docker volume: $VOLUME_NAME"
echo "Output directory: $OUTPUT_DIR"

# Copy files from volume to local directory
docker run --rm \
    -v "$VOLUME_NAME:/data" \
    -v "$(pwd)/$OUTPUT_DIR:/output" \
    alpine sh -c "cp -r /data/* /output/ 2>/dev/null || echo 'No files found in volume'"

echo "✅ Recordings extracted to: $OUTPUT_DIR"
echo ""
echo "To view files:"
echo "  ls -la $OUTPUT_DIR"

