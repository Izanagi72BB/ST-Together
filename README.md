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

The host needs two parts: the UI extension (installed from inside
SillyTavern) and the server plugin (installed with one command in a
terminal, one time only).

### Part 1: the UI extension

1. In SillyTavern, open the Extensions panel (the stacked-blocks icon in
   the top bar).
2. Click **Install extension**.
3. Paste `https://github.com/Izanagi72BB/ST-Together` and confirm.

### Part 2: the server plugin

1. Find your SillyTavern folder. It is the folder that contains
   `config.yaml`, and `Start.bat` on Windows or `start.sh` on Linux/Mac.
   If you use the SillyTavern Launcher, it is the `SillyTavern` folder
   inside the launcher's folder.

2. Open a terminal **inside that folder**. This matters: the command in
   step 3 creates the plugin folder relative to wherever your terminal is
   standing, so running it from the wrong place puts the plugin in the
   wrong place. (If that happens, delete the stray `plugins` folder it
   created and start over from here.)

   - **Windows:** open the SillyTavern folder in File Explorer, click the
     address bar at the top, type `cmd`, and press Enter. A terminal opens
     already inside the folder.
   - **Linux/Mac:** `cd /path/to/your/SillyTavern` (the prompt should show
     the SillyTavern folder before you continue).

3. Run this command (identical on every OS):

   ```
   git clone https://github.com/Izanagi72BB/ST-Together plugins/st-together
   ```

   Windows note: if you get "git is not recognized", install
   [Git for Windows](https://git-scm.com/download/win) first, then reopen
   the terminal.

4. Open `config.yaml` (same folder) in any text editor, find the line
   `enableServerPlugins: false`, and change `false` to `true`.

5. Restart SillyTavern fully (close the server window / process and start
   it again, not just a browser refresh).

### Updating later

Automatic or one click: SillyTavern re-pulls the server plugin on every
server start, and the UI extension updates from the **Update** button
under Manage extensions. You never repeat the steps above.

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
