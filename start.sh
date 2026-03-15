#!/bin/bash
# ReelForge - One-click launcher
# Starts backend (FastAPI) + frontend (Vite) in one terminal

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}━━━ ReelForge ━━━${NC}"
echo ""

# Cleanup on exit — send SIGINT to uvicorn so it runs lifespan shutdown (VRAM cleanup)
cleanup() {
    echo ""
    echo -e "${CYAN}Shutting down...${NC}"
    # Send SIGINT to uvicorn so it triggers graceful shutdown + VRAM cleanup
    if [ -n "$BACKEND_PID" ]; then
        kill -INT $BACKEND_PID 2>/dev/null
        sleep 2  # Give uvicorn time to unload models
    fi
    kill $BACKEND_PIPE_PID $FRONTEND_PID 2>/dev/null
    # Kill any remaining uvicorn processes
    pkill -f "uvicorn backend.main:app" 2>/dev/null
    wait 2>/dev/null
    echo "Done."
}
trap cleanup EXIT INT TERM

# Install backend deps if needed
if [ ! -d ".venv" ]; then
    echo -e "${GREEN}Creating Python venv...${NC}"
    python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r backend/requirements.txt 2>/dev/null

# Install frontend deps if needed
if [ ! -d "frontend/node_modules" ]; then
    echo -e "${GREEN}Installing frontend deps...${NC}"
    cd frontend && npm install --silent && cd ..
fi

# Start backend (use setsid so we can kill the entire process group)
echo -e "${GREEN}Starting backend on :8000${NC}"
setsid uvicorn backend.main:app --reload --port 8000 2>&1 | sed 's/^/  [backend] /' &
BACKEND_PIPE_PID=$!
# Get the actual uvicorn PID (leader of the new session)
sleep 0.5
BACKEND_PID=$(pgrep -f "uvicorn backend.main:app" | head -1)

# Wait for backend to be ready
sleep 2

# Start frontend
echo -e "${GREEN}Starting frontend on :5173${NC}"
cd frontend && npm run dev 2>&1 | sed 's/^/  [frontend] /' &
FRONTEND_PID=$!
cd ..

echo ""
echo -e "${CYAN}ReelForge running at: http://localhost:5173${NC}"
echo -e "Press Ctrl+C to stop"
echo ""

# Wait for either to exit
wait $BACKEND_PID $FRONTEND_PID
