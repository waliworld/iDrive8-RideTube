# Changelog

## Service 0.5.2: iDrive 8, the car gives its audio focus and takes the playlist - its list stays empty

The same G8x answered 0.5.1 (22 photographed pages). Nothing played yet, but the car's own player now talks to us.
Still not confirmed on a car.

- **The focus is ours.** `getAudioFocus(jap_ridetube8, RideTube, 0)` answered `OK` with a token on all three
  entertainment instances, after `BAD_ARGUMENT` to every other timer: BMW's own code passes timer 0 for those
  instances (read on the car). Timer 0 is now asked first, under our own name first. The player then says
  `HAS_FOCUS` and `CS_CONNECTED`.
- **`createPlaylist` answers `OK` and the list stays empty** (`currentItemPosition 0/0`, no word of the item, no
  error), wherever the file was. Two things read on the car explain it and are now tried:
  - **The item's id.** BMW's `generateItemId` makes four bytes of the app's logging id as a number and a type per
    player instance (a static map of the class); ours were all zeros, because the reading ran it without either.
    The reader now runs BMW's own `generateItemId` for each instance the class knows and each number an app could
    have (ours written like a BMW app's, that of the app whose code was read, their low bytes, none).
  - **Where the file is.** The media player's configuration names a store for online media (`/mnt/share/ent/oe`).
    A copy of the file is put in a folder of ours there, owned as the store is, and removed with the play.
  A play first asks each id at each place (where the file is, the store, our app's folder) for a moment each and
  looks whether the item is in the list; one that is gets the starts at once. Then the likeliest id at every place
  with BMW's own start, and a look whether the car's media engine has the file open.
- **What BMW's code asks after its playlist is asked of the car the same way.** The reader now makes the class as
  an app does (`{ instance, clientName }`), runs `init` and `connect`, tells its own handlers that the focus and
  the connection are there, and records what `playFile` then asks; those calls are replayed with our token.
- **The Diagnostics page is rebuilt around what is still open**, about half as long: the story (one line where a
  car answered the same to many ways), where the car's media programs may read a file (who they run as, the store
  and what is in it, the folder of the app whose code was read), and how BMW's code plays a file (what the class
  carries, its ids, its calls, the text of what starts a playlist, of how the id's number is made, of where an app
  keeps its file). What the first car has told - its sound wiring, the audio manager's descriptions - is left to
  the whole page.
- **What BMW's code asks beside the player is read too.** After it sets an item's position, BMW's class sets a
  "sound property" through another connection to the car than the player's. The reader records whom that is asked
  of and with what, and the page shows it with the text of that method and which interface of the car's catalog
  has such a method (its instances). Nothing of it is asked of the car yet.
- The audio manager's lists of sources and sinks say why they could not be read.

## Service 0.5.1: iDrive 8, what the first car answered to 0.5.0

A G8x on iDrive 8 answered 0.5.0 (three photographed pages). None of it played; this is what it said and what
follows from it. Still not confirmed on a car.

- **The dynamic player refused the audio focus**: `BAD_ARGUMENT` to every name we gave with every timer, on all
  three instances - so no playlist was ever asked. `getAudioFocus` is now asked in many more ways (the names BMW's
  own code passes where they are plain words; timers from none to a minute; shown under our title, under the name
  itself and under nothing), and the story has one line of it instead of one a try (they filled two pages).
- **How BMW's own code asks for the focus is now at the top of the Diagnostics page**: its call as the reading
  recorded it, the text of the methods that make it, the bundle's own words around `clientName:` and around the
  app's "Register audio focus failed", and how that app and ours name themselves in their packages.
- **The router has no device for our source on this car.** Its only free devices were CarLife's and Android Auto's
  (they take no samples with our source connected); the audio manager's names (`OAPMedia`, `DynamicMedia`, ...) are
  not devices. So the probe now reads how the car's programs are wired to its sound, without opening anything:
  which program has which kernel sound device open and which buffer mapped, the kernel's streams in use, the
  devices the ALSA configuration defines, and what the media engine's configuration says of its output.
- The probe no longer lists the audio manager's names, nor other sources' media devices; the telephone's and the
  speech devices (`Voip`, `eSimCall`, `Nuance`), which 0.5.0 opened for a moment as "other" devices, are never
  touched. Where setting a device up fails, libasound's own word of the step that failed is kept.

## Service 0.5.0, app 0.4.6: iDrive 8, a play works through every way to sound until one plays

Nobody has heard RideTube on an iDrive 8 yet, and every single guess cost its driver a trip to the car. So a play
there no longer tries one thing: it works through every way this service knows, on its own, keeps the one that
plays, and writes down each answer of the car (`sound.js`).

- **BMW's own way of asking the car's player, read on the car** (`sdkread.js`). The apps installed on the car carry
  the SDK's player class. The service finds such an app, and in a child process without privileges (nobody, no
  environment, a time limit; the app itself never runs) loads that class with the bundle's own modules and runs its
  `playlistConverter`, `createPlaylist`, `playFile` and `connect` against a recording stand-in of the player's proxy.
  What comes back: the playlist item exactly as BMW's code writes it (its union value, its byte buffer), what
  `getAudioFocus` is given, the heartbeat's cadence, what starts a playlist. The play uses that first. It is read
  once and kept (`state/sdk.json`); nothing of it leaves the car but lines on the Diagnostics page.
- **The service's own player, first** (`ytaud`, `ytalsa.py`): it needs seconds, not minutes. `ytaud` (new: FAAD2,
  static) decodes the file and `ytalsa.py` writes the samples to the car's audio router through ALSA
  (`plug:smartx:<device>`, libasound loaded with ctypes). The router is Intel's SmartXbar, whose source is public,
  and it reads a device only while that device's source is connected to a loudspeaker. So which device is ours is
  measured instead of guessed: silence is written to all the free devices named like ours at once, as the car is
  and again once the audio manager has connected our source as on iDrive 7 - the one that takes samples as time
  passes only then is ours, and the play goes there. Where none of those does, the router's other free devices are
  listened to as well (never the telephone's, the navigation's, a warning's or another source's). A device another
  program has open is never touched; who has which is read from the router's locks.
- **The dynamic player's audio focus with our own player.** Asking that player for the focus makes the car connect
  its source; where a device then takes samples, our samples go there - no playlist, and no file the car must read.
  Each instance the car has for the entertainment (`Media`, `TempMedia`, `TempLumMedia`) is tried this way before
  the long way below.
- The player is written to what the router's source code shows: a device is opened blocking (a non-blocking open
  tells the router not to read it), written to without blocking, started by hand, and never prepared a second time
  (its position would be nonsense); a pause stops feeding it, a broken stream is opened anew. Every call that waits
  for the router's answer has a time limit - its plugin has none - and each device of a listening has a process of
  its own, so one the router never answers for, or whose plugin ends the process, costs only itself.
- With the service's own player a pause and a resume go on in place (BMW's player has to be connected anew each
  time); the whole file takes over from the first seconds exactly where those are; and when the car gave its sound
  to another source meanwhile, the player says so at the resume and its way is asked for anew.
- A way that takes samples and is still not heard may wait for a word to the audio manager: once **No sound?** was
  said of such a way, the Diagnostics page also describes the audio manager's interfaces for players
  (`AmPlayerState`, `AmSourceControl`), made from the unit's catalog.
- **The dynamic media player's playlist, searched.** For each instance: the focus (the heartbeat timer's unit is
  tried as milliseconds and as seconds), then the item in BMW's form and - where that could not be read or is
  refused - in every other likely form, with the file where it is, as a copy in our app's data folder (where BMW's
  apps keep what they play), as `file://`, under `/run` and as `http://127.0.0.1` from the service, and each way to
  start a playlist (by itself, `setCurrentItemPositionAndTime`, `PLAY`, `setAutoplay`). What the player says back
  decides what is tried next: its own words of the item, its error events, its state. A combination the service
  died in is not tried again.
- **"No sound?"** on the player (pressed twice) where a way was found by trying: the service leaves that way out
  and goes on, from where the video was, with the next. Settings has **Sound: start over**.
- While all this runs the player says so ("Finding how this car plays sound: way 3..."), also for the wait while
  the car is still starting. The Diagnostics page begins with **Sound on this car**: what is kept, or the story of
  the last search, a line an attempt; then **The car's sound devices**: what was listened to and what took samples,
  every device the router has, which program has which open, and which player the car's configuration gives each
  to; further down BMW's player code as read.
- The player's time may come in seconds or not at all there: its unit is told by how it moves, and where it says
  none the service counts on, so the picture has its clock.
- The update is refused on the car (instead of a service that does not start) if the unit's Node does not load the
  service's files (`check.sh`).

## Service 0.4.9: iDrive 8, a play during the start waits; the dynamic player is given a moment to answer

0.4.8 on a car, three minutes after its start: two plays ended with "the car's audio is not ready" (the first
while the service kept away from the starting head unit, the second in the second its start ran), so the dynamic
player was never asked. And its proxy, made a moment before, said "not available" where 0.4.7 had read "yes".

- A play while the head unit is starting waits for the service's start to be over (the player shows loading)
  rather than ending after 10 s.
- The dynamic player's proxy is made at the service's start, and a play gives it 5 s to answer.

## Service 0.4.8: iDrive 8, a play goes through the car's dynamic media player

0.4.7's pages from a car: the DynamicMediaPlayer's `DynamicMediaPlayerMedia` answers this service (playerState
`PLAYER_STATE_STOP`, `CS_DISCONNECTED`), and the SDK inside BMW's own app shows how it is asked - `MediaPlayerImpl`:
`createPlaylist({token, newPlaylist})`, `sendButtonEventDirect({token, button, action: "PRESS"})` then `"RELEASE"`,
an empty playlist to stop, `playFile(file, startTime, mediaType, fileSize)` making the item `{fileName, metadata:
[{key: "FILE_SIZE", value}]}`. Positions count from 1.

- Where the car does not offer iDrive 7's player and its dynamic player answers, a play goes through it:
  `getAudioFocus` (a token, kept alive with `heartBeat`), `createPlaylist` with the file as its one item
  (`FILE_NAME`, `FILE_SIZE`), `PLAY`; pause, resume and stop as buttons, a seek with
  `setCurrentItemPositionAndTime`; at the end an empty playlist and `releaseAudioFocus`. Its `playerState` and
  `currentItemTime` are the MediaPlayer's, so the picture follows the sound as on iDrive 7. The audio manager is
  not asked: the dynamic player has its own focus.
- Not read from the car yet: how the SDK writes an item's union value and byte buffer for the binding
  (`playlistConverter`). The likeliest forms are tried until the player takes one; which, and every answer of the
  player, are on the Diagnostics page under *Last play through it*. If the player takes the file and does not
  play, the play ends with that, and nothing of ours is left in the car's player.
- The page's code reading now shows what is still open (`playlistConverter`, `timeOutHeartBeatTimer`, `heartBeat`,
  `stringValue`, `setCurrentItemPositionAndTime`, the `ePlay` state), from the one app, not the app manager.
- `dynamic: false` (the service's options) keeps to iDrive 7's way.

Not heard on a car yet.

## Service 0.4.7: iDrive 8, how the car's own code asks its dynamic player to play

0.4.6's pages printed the DynamicMediaPlayer whole: a player with its own audio focus and playlist -
`getAudioFocus(clientId, clientName, timeOutHeartBeatTimer) -> token`, `createPlaylist(token, [{pos, id, metadata}])`,
`sendButtonEventDirect(token, button, action)`, `heartBeat(token)`, `setTime`, `releaseAudioFocus`; fields
`currentAudioFocus`, `playerState`, `currentItemTime`; events `buttonEventForward`, `playbackErrorEvent`. What an
item must say for the car to play a file (which metadata, how the binding takes a union or a byte buffer) is not
in a description: it is in the code that calls it.

- When the Diagnostics page is opened (and the service has run three minutes), the app manager's own files and
  three BMW apps that play media are read (not every app), and the page shows the code around `createPlaylist`,
  `getAudioFocus`, `addToPlaylist`, `sendButtonEventDirect`, `heartBeat`, `FILE_NAME`, `playFile`. The page is sent
  again when the reading is done.
- The page asks the dynamic player's first instance (one proxy, reads only): whether it answers this service at all,
  and its fields now.
- The page leaves out what 0.4.6 has told (the description, the policies, the processes, the files).

## Service 0.4.6: iDrive 8, the service keeps away from the car while it starts

The Store's apps went missing again on 0.4.4, before any update: so the start-up probing of 0.4.3 was not the cause,
or not the only one. What every version of the service has done on iDrive 8 is start with the head unit and ask
the car's SOME/IP for the audio in the same seconds the app manager and the Store's own start step run.

- On iDrive 8 the service now loads no SOME/IP binding and makes no proxy until the head unit has been up 150 s. Its
  socket answers meanwhile (search and the pages work); a play in that time says it is waiting. iDrive 7 is unchanged.
- The apps' code is no longer read on the head unit (`codeScan`, off). `tools/id8_collect.js` reads it from a computer.
- Whether this is the cause is not known: `tools/id8_collect.js` takes the Store's status and the start's logs.

## Service 0.4.5: iDrive 8, the Diagnostics page says the rest (the app stays 0.4.5)

With 0.4.4 the car's Store apps show again. Its pages gave the DynamicMediaPlayer (service 0xb0c0, five instances,
methods that take a token: addToPlaylist, sendButtonEventDirect, setCurrentItemPositionAndTime ...) but cut its
description in half, and the code around it was still being read when the pages were photographed.

- The description is printed in short and whole: every method with its arguments and answer, the fields and events,
  each enumeration once.
- The reading of the apps' code sends the page again when it is done (no Refresh).
- *What runs the media* also names the sound devices (ALSA's configuration), the audio manager's names of the OAP,
  online and dynamic media, and what on the unit could play a file (gst-launch-1.0, aplay; the GStreamer plugins).
- CommandControl: where MainApp's description lacks the lists of sources and sinks, an installed app's own
  description of the same interface is used (one proxy, as before), so the page shows the car's sources and sinks.
- `tools/id8_collect.js` takes the same sound facts.

## Service 0.4.4: iDrive 8, the start-up probing of 0.4.2 and 0.4.3 is off

After 0.4.3 a car's Store apps were slow to show after a start, then did not show. Not proven to be the service, but
0.4.3 was the first to load the app manager's generator in its own (root) process, to open a second CommandControl
proxy and DynamicMediaPlayer proxies, to ask all 55 players, and to read the apps' code 45 s after the start. All
of it is off by default now (`probe`): the service makes the two proxies iDrive 7 needs and nothing else. The
Diagnostics page still prints the DynamicMediaPlayer's description (a file read) and reads the code around it, but
only when the page is opened, three minutes or more after the service started, and slowly.

## Service 0.4.3: iDrive 8, what plays for the apps there (diagnostics; the app stays 0.4.5)

The Diagnostics pages of 0.4.2 from a car: the MediaPlayer's `OapGenericMedia` (service 0xb042, instance 0x28) is not
offered, like every on-demand player (Dynamic*, Browser*, Alexa); only the connected devices' players answer. The
app manager (MainApp-21) has no description of the MediaPlayer at all: of the audio it has CommandControl and a
`DynamicMediaPlayer`. So on iDrive 8 a player is made on demand, through an interface nobody has documented. This
release reads what is needed to use it; it calls nothing new.

- *The dynamic media player*: its description (printed whole: methods, arguments, fields), its instances asked,
  its fields read.
- The code around it: the interface calls near `DynamicMediaPlayer` in the app manager's code, and pieces of the
  code around `DynamicMediaPlayer`, `playFile`, `OapGenericMedia` (the app manager's code is read first).
- *What runs the media*: the processes and systemd units of the media and the audio, the sound cards.
- The audio manager's sources and sinks, read through a description made of the unit's catalog (MainApp's own lacks
  the two lists); all of the MediaPlayer's instances are asked (0.4.2 stopped at 32); the catalog's audio
  interfaces are listed in full. The page is shorter where it was long (instances counted, players summed up).

## Service 0.4.2: iDrive 8, "Service unavailable for call playFile()" (the app stays 0.4.5)

On a car, service 0.4.1 got the audio manager up and its `connect` accepted; the play then stopped at
`Service unavailable for call playFile() (the car's MediaPlayer "OapGenericMedia" is not available)`: this iDrive 8
has a description of the MediaPlayer, and does not offer (or does not let this service see) the instance iDrive 7
plays OAP media with.

- **The players the car does offer are asked.** When the player in use does not answer at the start (3 s), every
  instance of every description of the MediaPlayer on the unit (MainApp's, a numbered one, the apps' copies) is
  given a proxy and asked. Used instead: the same instance under another description (a numbered interface), else
  the only offered instance named like the generic OAP media player, with the audio source named like it. Nobody
  else's player (USB, Bluetooth) is tried. `audio.json`'s instance is never replaced. A play looks again, and goes
  back to the measured instance once the car offers it.
- **A player started with its source.** At a play, a player that does not answer is given 4 s once the source is
  connected, before `playFile`.
- **The error says it**: "the car does not offer the media player "OapGenericMedia" on this head unit (Settings >
  Diagnostics)".
- **Diagnostics, for the next step if none is offered**: the players asked and which answer; each interface's SOME/IP
  service and instance id; *Who may use them* - the unit's SOME/IP security policies (`/etc/vsomeip`: who may ask
  for and who offers the audio manager and the player, and whether this service is named); *How the installed apps
  play media* - the code of the installed apps and the app manager read once in the background (bounded) for the
  player instances, interfaces, playback calls and SDK media modules they use.

## App 0.4.5, service 0.4.1: iDrive 8, "Error: audio service timed out"

First run of the whole app on a car (0.4.4): it draws, touch, the keyboard, search and thumbnails work. A video
stops at "Error: audio service timed out": the service never got the car's audio up, and said so in a journal
nobody can read from the driver's seat.

- **The service says why.** The audio start is followed step by step (the SOME/IP binding, the audio manager's and
  the media player's descriptions, their proxies, the audio manager answering, its lists, leftover connections). A
  play that finds it not up ends with the reason ("the car's audio is not ready - the car's audio manager
  (CommandControl) does not answer"), not a timeout. A proxy that never starts no longer holds the start for good:
  each try is given 8 s, and the next one joins it.
- **Settings > Diagnostics** (the rail's Settings card): pages of text to read or photograph. The app's lines (its
  version, the renderer, the speed signal), then the service's, asked with the new `diag` command: where the audio
  start stopped and its last error; the descriptions found, the instance used of those each has, whether each
  answers; the route (source, sink, whether the car lists them); the car's sources, sinks and connections; the last
  play (what `connect` and `playFile` answered) and the player's last events; where the head unit keeps the
  descriptions (MainApp's folders, the installed apps' `someipInterfaces/`, the interface catalog, the app manager's
  generator, and a bounded search for them elsewhere when one is missing); the video decoder; the log's last lines.
- **It looks further for what iDrive 7 has in one place.** The two descriptions: MainApp's folders as before, then an
  installed app's `someipInterfaces/`, then a numbered name (`...mediaplayer2_MediaPlayer2.json`, as iDrive 8 numbers
  its HMI's interfaces), then made from the unit's interface catalog by the app manager's own generator. The
  instance: CommandControl's only one where it has no `1`; the player's only one named like the generic OAP media
  player where it has no `OapGenericMedia`. The sink: where 1024 is not on the unit, the only sink, or the only one
  the car's own connections use; among several nothing is picked. Each of these is logged and shown on the page.
  `state/audio.json` still wins. A head unit that has everything where iDrive 7 has it starts as before.
- A `connect` or `playFile` the binding rejects with something that is no Error says which call failed, and a
  player whose instance is not offered is named in the error.
- The kit has `textSheet` (pages of wrapped plain text). `kit/tools/test_node8.js` also checks the service.

Nobody has heard this play on an iDrive 8 yet: if a video still does not play, the Diagnostics pages are the report.

## App 0.4.4: iDrive 8, the page opened but the app's code did not load

First run past the tile on a car (0.4.3): the page opened and said "RideTube - did not load ... the kit was loaded
without the app's entry module". The start, the tile and the page work there; the hand-over of the SDK did not.

- The entry module gave the SDK to the kit through a global. On the car the linked bundle does not run with the
  `global` the package's other files see (the head unit's entry point loads the bundle its own way), so the kit,
  loaded one line later, found nothing. The SDK and the host now go through the kit's own module (`kit/sdk.js`
  `give`), which Node's module cache keeps one of. The test's stand-in for the car's entry point now runs the bundle
  in a JavaScript context of its own; the published 0.4.3 shows the car's exact message there.
- Nothing in the kit tells what an object from the entry module is with `instanceof` any more (a `Map` from the
  SDK's context is no instance of the kit's).
- **The renderer is spoken to as the iDrive 8 apps known to draw on a car speak to it** (IterioDev's dialect of
  mgu-render's protocol: the app id alone in HELLO, touch claims, pictures and videos by the same message numbers
  mgu-render/1 uses, a layer). 0.4.0 to 0.4.3 asked for mgu-render/1, where an app shows only while the renderer's
  foreground gate names it in front - a reading of the HMI nobody has confirmed on an iDrive 8, and one that
  hides the app if it finds nothing; a legacy connection is left as it is in that case. `MGU_RENDERD_PROTO=native`
  asks for mgu-render/1 on iDrive 8 again. iDrive 7 is unchanged.
- The renderer's status line says the dialect and whether touch areas are claimed.

## App 0.4.3: iDrive 8, the tile greys out and nothing opens - the app had no SDK

The cause of the report from the car (0.4.0 to 0.4.2): tapping RideTube's tile greys it out and nothing opens.

- The MGU Store's deploy tool gives an app BMW's oap-sdk in two ways. On iDrive 7 it generates the module
  `node_modules/oap-sdk` for a package that asks for it, which is how the original RideTube runs there. On iDrive 8
  it does not: there it only builds source packages (`mgu-app.json`), linking the modules they list against the
  oap-sdk of an app already on the car. RideTube for iDrive 8 was published as a package of the first kind. It
  installed, got its tile, and its process ended at the first line that loads the SDK, every time it was started.
  Reproduced with the deploy tool on its simulated iDrive 8 unit: the package queued for the car has no SDK in it.
- RideTube for iDrive 8 is now a source package, the kind the Store's own app is. One module is linked on the car,
  the kit's new entry module (`kit/id8/boot.js`); the kit and the app are plain files of the package and get the SDK
  from it (`kit/sdk.js`). The catalog lists it with `"build": "unit"`.
- The entry module does the start, the tile and the shutdown as the Store's app does them (its `store.js`,
  GPL-3.0-or-later, written again for the kit), and none of it waits for RideTube's own code or fails with it: if
  that code does not load or start, the page still opens and says what failed.
- iDrive 8 `permissions.json` names iDrive 8's interfaces (it had iDrive 7's); the app's log id is its own (`RTB8`).
- The page's first status line is the entry module's: version, start reason, tile, page, the app's code.
- Tests: `kit/tools/test_mgu8.js` builds the source package with the Store's own linker (the file its deploy tool
  runs on the car) and starts the result through its `main`, with no module named `oap-sdk` to be found;
  `kit/tools/test_node8.js` parses every file that ships as Node 8 does.
- 0.4.1's and 0.4.2's changes to how the screen follows the page stay, but they were not the cause.
- iDrive 7: as the original (the kit's start there is back to the original, with a listener for the SDK's `error`
  event).

## App 0.4.2: iDrive 8, the tile opens nothing / the page stays grey

Still reported from an iDrive 8 car: the tile is tapped, the screen goes grey, RideTube never shows. Not confirmed
on a car yet; each point below is a way the iDrive 8 start differed from the apps that are known to run there (the
MGU Store's app, IterioDev's apps), and each fails in the new tests on 0.4.1.

- The app said INACTIVE to the app manager once it took its page for hidden, and "HMI not visible" with every screen
  stack that did not name it. On iDrive 8 it now reports ACTIVE at the start and nothing else, as those apps do.
- A screen stack without `ROOT_APP` no longer hides the screen (0.4.1 still did). The page's own visible event
  decides; the stack only on an HMI that sends no visible events at all.
- The SDK's `error` event has a listener (without one Node ends the process), a focus event that is a bare value
  no longer throws, and an uncaught error is logged and shown instead of ending the app.
- The start goes on from the SDK's `initialized` event or `start()`, whichever comes first; the page is opened for
  the entry point the app was started with whatever the SDK calls the start reason, asked again after any refusal,
  and opened even when the mapping was refused.
- The tile keeps the manager's own name and icon (set from the app's bundles they go with the app's process, and
  the tile is left blank once the app stops). Each step of making it usable is tried on its own.
- The car's speed and battery are read through the SDK's typed proxies on iDrive 8, not the raw SOME/IP binding
  with iDrive 7's interface files; the manifest names those interfaces whole, as IterioDev's iDrive 8 apps do.
- **The page says what is wrong.** The HMI's own page under RideTube's screen now has four status lines (the
  version and how it was started, the page, the renderer, the service) and the reason in its title. While
  RideTube draws they are covered; when it does not, a photo of the screen says why.
- The string bundle is the page's own texts only (no dynamic slots).
- iDrive 7: unchanged but the `error` listener.

## App 0.4.1: iDrive 8 grey page

- iDrive 8: the page stayed grey (the HMI's empty page, RideTube's screen never drawn over it). The kit read the HMI's
  screen stack as on iDrive 7 (the page's numeric id in a list) and took any stack that did not list it that way
  for the page gone, so the renderer was told to hide RideTube right after it opened. On iDrive 8 the page's own
  visible event (true, 1 or "true") decides, as in the MGU Store's app and IterioDev's iDrive 8 apps; the stack
  only says the app is in front (ROOT_APP) or was left. The first HMI events go to the app's log.
- iDrive 8: when the screen still can't be drawn (no renderer, another app in front...), the page's title says why
  after 4 s instead of a silent grey page.
- Tests: kit/tools/test_mgu8.js starts the built app against a fake iDrive 8 HMI and a fake mgu-render.

## App 0.4.0, service 0.4.0: iDrive 8

- iDrive 8 (experimental, not yet run on a car): a second app, `jap_ridetube8` (`build.py --hmi ID8`), from the same
  code. The kit draws the whole screen on the app area of the 2880 x 960 display, with its own back button, an
  on-screen keyboard for Search (typing only while parked, recent searches as buttons), and the rail's Settings
  (account and settings). Touch only.
- Service: finds BMW's interface descriptions on iDrive 8 (`oap-mainapp21`), logs the audio manager's sources and
  sinks, takes another audio route from `state/audio.json`, says whether the head unit has the GPU decoder's Media
  SDK; `mguHmi` iDrive 7 and 8.
- The catalog has an entry per head unit; iDrive 8's does not require the controller gate (iDrive 7 only).
- iDrive 7: unchanged (the same package but the version).

## Service 0.3.9

- Videos play again: each video's folder was 0700, so BMW's media engine (its own uid) could not open the audio
  and the car answered `ITEM_UNPLAYABLE`. The folders are now 0711: the engine opens the audio by name, and
  nobody can list them. Folders cached by 0.3.8 are fixed when they are played.

## App 0.3.8

- Search: the menu opened from the rail's Search stays open. Before, the video page came back over it about a
  second later, because the head unit keeps that page listed under the menu. The kit now shows the page only
  while it is the screen of ours that came to the front last.

## App 0.3.7, service 0.3.8

- Video while driving takes effect only once switched on while the car is parked.
- The download stops when less than 256 MiB is left free on the head unit.
- README: data use, tested on, uninstall.

## App 0.3.6, service 0.3.7

First public release.
