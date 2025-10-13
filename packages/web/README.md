# Real-Time Voice App

A Next.js application that connects directly to OpenAI's Realtime API using WebRTC for voice interaction with mute/unmute controls and audio visualization.

## Features

- Real-time voice interaction with OpenAI's GPT-4o Realtime API
- WebRTC-based audio streaming for low latency
- Live audio level visualization
- Mute/unmute controls
- Password authentication for access control
- Agent activity transparency (debug log panel)
- Real-time agent status display
- Tool call visibility
- Clean, minimal UI

## Tech Stack

- Next.js 14+ (App Router)
- TypeScript
- OpenAI Realtime API (WebRTC)
- Web Audio API (for visualization)
- Tailwind CSS
- Native browser WebRTC APIs

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env.local` file in the root directory:
```bash
OPENAI_API_KEY=sk-your-api-key-here
AUTH_PASSWORD=your-secure-password-here
```

**Note**: The `AUTH_PASSWORD` is required to access the app. Users will be prompted to enter this password before they can use the voice interface.

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Important: HTTPS Requirement

**This app requires a secure context (HTTPS or localhost) to access the microphone.** This is a browser security requirement, not a limitation of this app.

### Desktop Development
- ✅ `http://localhost:3000` works (localhost is considered secure)
- ✅ Desktop browsers allow microphone access on localhost

### Mobile Development

Mobile browsers **require HTTPS** for microphone access. Localhost won't work on mobile. You have several options:

#### Option 1: Cloudflare Tunnel (Recommended)
Free and easy to set up:
```bash
# Install cloudflared
# macOS
brew install cloudflare/cloudflare/cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:3000
```
You'll get an HTTPS URL like `https://xxx.trycloudflare.com` that works on mobile.

#### Option 2: ngrok
```bash
# Install ngrok from https://ngrok.com
ngrok http 3000
```
You'll get an HTTPS URL like `https://xxx.ngrok.io`

#### Option 3: Tailscale (For your local network)
If you're already using Tailscale:
```bash
# Your app is accessible at:
https://your-machine-name.tailnet-name.ts.net:3000
```

#### Option 4: Local HTTPS Certificate
Set up a local SSL certificate (more complex):
```bash
# Generate certificate
mkcert -install
mkcert localhost

# Update next.config.js to use HTTPS
# (Requires additional Next.js configuration)
```

### Testing on Mobile
1. Set up one of the HTTPS options above
2. Access the HTTPS URL on your mobile device
3. Grant microphone permissions when prompted
4. The app should work normally

## Usage

1. Click "Start Voice Chat" to begin
2. Allow microphone access when prompted
3. Start speaking - the AI will respond in real-time
4. Use the "Mute" button to disable your microphone
5. The volume bar shows your audio level in real-time
6. Click "Disconnect" to end the session

## Project Structure

```
app/
├── page.tsx                      # Main page
├── voice-client.tsx              # Main client component
├── components/
│   ├── volume-bar.tsx           # Audio level visualization
│   └── mute-button.tsx          # Mute/unmute control
├── hooks/
│   ├── use-audio-level.ts       # Audio analysis hook
│   └── use-webrtc-voice.ts      # WebRTC connection logic
└── api/
    └── session/
        └── route.ts              # Generate ephemeral tokens
```

## How It Works

1. **Token Generation**: The backend endpoint (`/api/session`) securely generates ephemeral tokens from OpenAI
2. **WebRTC Connection**: The client establishes a peer-to-peer WebRTC connection with OpenAI's servers
3. **Audio Streaming**: Microphone audio is streamed in real-time to OpenAI
4. **AI Responses**: OpenAI's responses are received and played through the browser's audio output
5. **Visualization**: Web Audio API analyzes the microphone input to display volume levels

## Browser Compatibility

- Chrome/Edge (recommended)
- Firefox
- Safari (may require user gesture for AudioContext)

## Troubleshooting

### Microphone not working
- Check browser permissions for microphone access
- Ensure you're using HTTPS or localhost
- Check system microphone settings

### No audio output
- Check speaker/volume settings
- Verify audio permissions in browser
- Check browser console for errors

### Connection fails
- Verify OPENAI_API_KEY is set correctly
- Check network connectivity
- Tokens expire after 60 seconds - reconnect if needed

## License

MIT
