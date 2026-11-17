import config from "@colyseus/tools";
import cors from "cors";
import express from "express";
import { FrontierRoom } from "./rooms/FrontierRoom.js";

export default config({
  initializeGameServer: (gameServer) => {
    gameServer.define("frontier", FrontierRoom);
  },

  initializeExpress: (app) => {
    app.use(cors());
    app.use(express.json());

    app.get("/health", (req, res) => {
      res.json({ status: "healthy", game: "Slow Burn Frontier" });
    });
  },
});
