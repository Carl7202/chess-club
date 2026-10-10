
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Chess } from "https://esm.sh/chess.js@1.4.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return respond({ error: "Sign in first." }, 401);

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } =
      await userClient.auth.getUser();

    if (authError || !user) {
      return respond({ error: "Invalid session." }, 401);
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const body = await req.json();
    const action = body.action;

    // Ensure every guest has a club profile.
    const { data: existing } = await admin
      .from("profiles").select("id").eq("id", user.id).maybeSingle();

    if (!existing) {
      const username = "Player_" + user.id.replaceAll("-", "").slice(0, 8);
      const { error } = await admin.from("profiles").insert({
        id: user.id, username, rating: 1200,
      });
      if (error) throw error;
    }

    if (action === "create") {
      const code = crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();

      const { data, error } = await admin.from("rooms").insert({
        code,
        white_id: user.id,
        status: "waiting",
        fen: "start",
        ply_count: 0,
      }).select().single();

      if (error) throw error;
      return respond({ room: data, side: "w" });
    }

    if (action === "join") {
      const code = String(body.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        return respond({ error: "Enter a six-character room code." }, 400);
      }

      const { data: room, error } = await admin
        .from("rooms").select("*").eq("code", code).maybeSingle();

      if (error) throw error;
      if (!room) return respond({ error: "Room not found." }, 404);

      if (room.white_id === user.id) {
        return respond({ room, side: "w" });
      }

      if (room.black_id && room.black_id !== user.id) {
        return respond({ error: "This room is full." }, 409);
      }

      if (room.status === "finished") {
        return respond({ error: "This game has finished." }, 409);
      }

      if (!room.black_id) {
        const { data: updated, error: joinError } = await admin
          .from("rooms")
          .update({ black_id: user.id, status: "playing" })
          .eq("id", room.id)
          .is("black_id", null)
          .select().maybeSingle();

        if (joinError) throw joinError;

        // Another player may have joined at the same time.
        if (!updated) {
          return respond({ error: "Someone just took that seat. Try another room." }, 409);
        }

        return respond({ room: updated, side: "b" });
      }

      return respond({ room, side: "b" });
    }

    if (action === "move") {
      const roomId = String(body.roomId || "");
      const from = String(body.from || "");
      const to = String(body.to || "");
      const promotion = String(body.promotion || "q");

      if (!/^[a-h][1-8]$/.test(from) ||
          !/^[a-h][1-8]$/.test(to) ||
          !["q", "r", "b", "n"].includes(promotion)) {
        return respond({ error: "Invalid move format." }, 400);
      }

      // Lock the room row so simultaneous moves cannot overwrite each other.
      const { data: locked, error: lockError } = await admin.rpc(
        "lock_chess_room", { p_room_id: roomId }
      );

      if (lockError) {
        return respond({
          error: "Move-lock function is missing. Install the SQL function below.",
        }, 500);
      }

      const room = locked?.[0];
      if (!room) return respond({ error: "Room not found." }, 404);

      if (room.status !== "playing" ||
          ![room.white_id, room.black_id].includes(user.id)) {
        return respond({ error: "You are not an active player in this game." }, 403);
      }

      const game = new Chess();
      if (room.fen !== "start" && !game.load(room.fen)) {
        return respond({ error: "Stored board position is invalid." }, 500);
      }

      const isWhite = user.id === room.white_id;
      if ((game.turn() === "w") !== isWhite) {
        return respond({ error: "It's not your turn." }, 409);
      }

      let move;
      try {
        move = game.move({ from, to, promotion });
      } catch {
        move = null;
      }

      if (!move) return respond({ error: "Illegal chess move." }, 400);

      const ply = room.ply_count + 1;
      const finished = game.game_over();
      const result = game.in_checkmate()
        ? (game.turn() === "w" ? "0-1" : "1-0")
        : finished ? "1/2-1/2" : null;

      const { error: moveError } = await admin.from("moves").insert({
        room_id: roomId,
        ply,
        uci: from + to + (move.promotion || ""),
        san: move.san,
        created_by: user.id,
      });

      if (moveError) throw moveError;

      const { data: updated, error: updateError } = await admin
        .from("rooms")
        .update({
          fen: game.fen(),
          ply_count: ply,
          status: finished ? "finished" : "playing",
          result,
        })
        .eq("id", roomId)
        .eq("ply_count", room.ply_count)
        .select().maybeSingle();

      if (updateError) throw updateError;
      if (!updated) {
        return respond({ error: "Board changed; refresh and try again." }, 409);
      }

      return respond({
        room: updated,
        move: { from: move.from, to: move.to, san: move.san },
        fen: game.fen(),
        result,
      });
    }

    return respond({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error(err);
    return respond({ error: "Server error. Check the Edge Function logs." }, 500);
  }
});
