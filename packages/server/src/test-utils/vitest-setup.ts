process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
process.env.SSH_ASKPASS = "/usr/bin/false";
process.env.SSH_ASKPASS_REQUIRE = "force";
process.env.DISPLAY = process.env.DISPLAY ?? "1";
