#!/usr/bin/env node
import { resolve } from "node:path";
import { startServer } from "./server.js";

// First positional arg = project directory to monitor; default to cwd
const argPath = process.argv[2];
const cwd = argPath ? resolve(argPath) : process.cwd();
const port = Number(process.env.PORT) || 9527;
const logPath = resolve(cwd, ".kda", "logs", "debug.log");

startServer(logPath, port);
