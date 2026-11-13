# Agent timeline example

A screen with the host's agents on the left and the selected agent's timeline on the right,
rendered with `AgentTimeline` from `@getpaseo/plugin/client/ui`. Switch between the simple
message box (`composer={{ controls: "none" }}`), the agent tab's toolbar with attachments
hidden, and a read-only timeline.

On a phone the list and the timeline take turns filling the screen. On a Paseo older than
0.16.0, where `AgentTimeline` is undefined, the screen offers **Open agent** instead.
