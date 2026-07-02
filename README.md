# ST-Together

Turn-based multiplayer for SillyTavern. You and a friend, each on your own
SillyTavern instance anywhere in the world, share one chat with one AI
character. The chat and the LLM API connection live entirely on the host's
machine; the guest needs no API key and no configuration beyond this
extension.

## How it works

- The **host** runs a small server plugin that referees the session:
  token-authenticated WebSocket, turn order, message relay.
- Both players install the same UI extension and pick a role: Host or Join.
- Remote play uses a throwaway Cloudflare quick tunnel (trycloudflare.com).
  No domain, no port forwarding, no exposed home IP. The invite URL dies
  when the session stops.
- Turns are fluid: the turn holder can write (the bot replies), extend the
  bot's last message (Continue), have the bot speak again (Bot Reply), or
  hand over (Pass Turn). Optionally the turn can auto-pass after each reply.
- Drafts are private. Only a boolean "is typing" signal leaves your machine,
  shown to the other player as a "X is writing" indicator with bouncing dots.
  The bot's reply streams live to both players.

## Install: host

1. In SillyTavern, go to Extensions, Install extension, and paste this
   repository URL. This installs the UI extension.
2. Clone this same repository into your SillyTavern `plugins/` folder
   (one-time; from your SillyTavern folder):

   ```
   git clone https://github.com/Izanagi72BB/ST-Together plugins/st-together
   ```

3. Set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
4. Restart SillyTavern.

Updates afterwards are automatic or one click: SillyTavern pulls the
plugin on every server start, and the UI extension updates from the
Update button under Manage extensions.

The tunnel uses `cloudflared`. If it is installed system-wide the plugin
uses that; otherwise the plugin downloads the binary into its own folder
on first use.

## Install: guest

1. Extensions, Install extension, paste this repository URL. Done.

## Play

1. Host: open the character chat you want to play in, then open the
   ST-Together drawer in the Extensions panel, pick Host, tick "Expose via
   Cloudflare tunnel" (skip it for same-machine testing), Start Session.
   Starting with the tunnel takes 30-60 seconds; the invite code appears
   once the tunnel is verified reachable.
2. Send the invite code (`stg://...#token`) to your friend.
3. Guest: open any character and a fresh chat to mirror into, pick Join in
   the ST-Together drawer, paste the invite, Join. The host's chat syncs
   over automatically.
4. Play. The action bar above the input shows whose turn it is and holds
   the Continue, Bot Reply, and Pass Turn buttons.

## Notes and limitations

- Host edits, deletes, and swipes sync to guests. Guest-side editing and
  swiping are disabled by design.
- If the host switches chats mid-session, stop and restart the session.
- Two instances on one machine for testing: open them under different
  hostnames (for example `127.0.0.1:8000` and `localhost:8001`), otherwise
  the instances fight over cookies and requests fail with CSRF errors.
- One host and up to three guests per session; designed and tested for two
  players.
