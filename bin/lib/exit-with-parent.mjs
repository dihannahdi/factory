// Preloaded (`node --import`) into the processes `factory demo` starts. Their stdin is a pipe from
// the demo; when the demo dies by any means, including a hard kill that runs none of its cleanup,
// the pipe closes and this process exits instead of running on as an orphan. Works the same on
// Windows, where killing a parent never takes its children with it.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
