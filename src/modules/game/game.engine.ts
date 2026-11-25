import { and, desc, eq } from "drizzle-orm";
import { SYSTEM_NAME } from "../../config";
import {
  db,
  games,
  gamePlayers,
  gameEvents,
  rooms,
  roomMembers,
  type Operator,
  type RoomSettings,
} from "../../database";
import { PLAYER_COLORS } from "../rooms/rooms.colors";
import { OperatorsRepository } from "../operators/operators.repository";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../errors";
import { realtimeHub } from "../../websocket/hub";
import {
  toPublicOperatorCard,
  type ActiveQuestion,
  type FeedItem,
  type PersonalizedGamePlayer,
  type PersonalizedGameState,
  type PublicOperatorCard,
} from "./game.types";

interface LivePlayerState {
  id: string;
  userId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  color: string;
  seatOrder: number;
  operator: PublicOperatorCard;
  livesRemaining: number;
  guessedAt: Date | null;
  eliminatedAt: Date | null;
}

interface LiveGameState {
  gameId: string;
  roomId: string;
  roomCode: string;
  status: "active" | "ended";
  currentTurnUserId: string | null;
  turnNumber: number;
  turnDeadlineAt: Date | null;
  turnTimerHandle: ReturnType<typeof setTimeout> | null;
  settings: RoomSettings;
  players: LivePlayerState[];
  feed: FeedItem[];
  spectatorFeed: FeedItem[];
  activeQuestion: ActiveQuestion | null;
  questionsAskedThisTurn: number;
  processedActionIds: Set<string>;
  startedAt: Date;
  endedAt: Date | null;
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

class GameEngine {
  // roomId -> LiveGameState
  private readonly liveGames = new Map<string, LiveGameState>();
  // roomId -> lobby chat feed (preserved into game if needed)
  private readonly lobbyFeeds = new Map<string, FeedItem[]>();

  getLiveGame(roomId: string): LiveGameState | undefined {
    return this.liveGames.get(roomId);
  }

  getLobbyFeed(roomId: string): FeedItem[] {
    return this.lobbyFeeds.get(roomId) ?? [];
  }

  pushLobbyChat(roomId: string, item: FeedItem) {
    const list = this.lobbyFeeds.get(roomId) ?? [];
    list.push(item);
    if (list.length > 80) list.shift();
    this.lobbyFeeds.set(roomId, list);
  }

  clearLiveGame(roomId: string) {
    const state = this.liveGames.get(roomId);
    if (state?.turnTimerHandle) {
      clearTimeout(state.turnTimerHandle);
      state.turnTimerHandle = null;
    }
    this.liveGames.delete(roomId);
  }

  cleanupRoom(roomId: string) {
    this.clearLiveGame(roomId);
    this.lobbyFeeds.delete(roomId);
  }

  /**
   * Builds a strictly personalized view for `viewerUserId`.
   * Before the game ends (and before the player themselves has guessed or been eliminated),
   * their own Operator card is NEVER included in the payload.
   */
  getPersonalizedState(
    roomId: string,
    viewerUserId: string,
  ): PersonalizedGameState | null {
    const state = this.liveGames.get(roomId);
    if (!state) return null;

    const isEnded = state.status === "ended";

    const players: PersonalizedGamePlayer[] = state.players
      .slice()
      .sort((a, b) => a.seatOrder - b.seatOrder)
      .map((p) => {
        const isSelf = p.userId === viewerUserId;
        const canSeeOwnCard =
          isEnded || p.guessedAt !== null || p.eliminatedAt !== null;
        const shouldHide = isSelf && !canSeeOwnCard;

        return {
          userId: p.userId,
          username: p.username,
          globalName: p.globalName,
          avatar: p.avatar,
          color: p.color,
          seatOrder: p.seatOrder,
          livesRemaining: p.livesRemaining,
          guessedAt: p.guessedAt ? p.guessedAt.toISOString() : null,
          eliminatedAt: p.eliminatedAt ? p.eliminatedAt.toISOString() : null,
          isSelf,
          isTurn: !isEnded && state.currentTurnUserId === p.userId,
          operatorHidden: shouldHide,
          operator: shouldHide ? null : p.operator,
        };
      });

    const isSpectator = !state.players.some((p) => p.userId === viewerUserId);

    return {
      gameId: state.gameId,
      roomId: state.roomId,
      roomCode: state.roomCode,
      status: state.status,
      currentTurnUserId: state.currentTurnUserId,
      turnNumber: state.turnNumber,
      turnDeadlineAt: state.turnDeadlineAt
        ? state.turnDeadlineAt.toISOString()
        : null,
      settings: state.settings,
      players,
      isSpectator,
      feed: state.feed.slice(-100),
      spectatorFeed: isSpectator ? state.spectatorFeed.slice(-100) : [],
      activeQuestion: state.activeQuestion,
      questionsAskedThisTurn: state.questionsAskedThisTurn,
      startedAt: state.startedAt.toISOString(),
      endedAt: state.endedAt ? state.endedAt.toISOString() : null,
    };
  }

  /**
   * Rehydrates the latest game for a room from PostgreSQL if backend restarted.
   */
  async ensureLoaded(roomId: string, roomCode: string, settings: RoomSettings) {
    if (this.liveGames.has(roomId)) {
      return this.liveGames.get(roomId)!;
    }

    const latestGame = await db.query.games.findFirst({
      where: eq(games.roomId, roomId),
      orderBy: [desc(games.startedAt)],
      with: {
        players: {
          with: {
            user: true,
            operator: true,
          },
        },
        events: {
          with: { user: true },
        },
      },
    });

    if (!latestGame) return null;

    const memberRows = await db.query.roomMembers.findMany({
      where: eq(roomMembers.roomId, roomId),
    });
    const memberColorByUserId = new Map<string, string>();
    for (const row of memberRows) {
      if (!memberColorByUserId.has(row.userId) || !row.leftAt) {
        memberColorByUserId.set(row.userId, row.color);
      }
    }

    const livePlayers: LivePlayerState[] = latestGame.players
      .sort((a, b) => a.seatOrder - b.seatOrder)
      .map((gp, idx) => ({
        id: gp.id,
        userId: gp.userId,
        username: gp.user.username,
        globalName: gp.user.globalName,
        avatar: gp.user.avatar,
        color:
          memberColorByUserId.get(gp.userId) ??
          PLAYER_COLORS[idx % PLAYER_COLORS.length]!,
        seatOrder: gp.seatOrder,
        operator: toPublicOperatorCard(gp.operator),
        livesRemaining: gp.livesRemaining,
        guessedAt: gp.guessedAt,
        eliminatedAt: gp.eliminatedAt,
      }));

    const sortedEvents = latestGame.events.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );

    const mapEventToFeed = (ev: (typeof sortedEvents)[number]): FeedItem => ({
      id: ev.id,
      type: (ev.eventType as FeedItem["type"]) || "system",
      userId: ev.userId,
      username:
        (ev.payloadJson?.username as string) ||
        ev.user?.globalName ||
        ev.user?.username ||
        "SYSTEM",
      text: (ev.payloadJson?.text as string) || "",
      meta: ev.payloadJson,
      createdAt: ev.createdAt.toISOString(),
    });

    const feed: FeedItem[] = sortedEvents
      .filter((ev) => ev.eventType !== "spectator_chat")
      .slice(-100)
      .map(mapEventToFeed);

    const spectatorFeed: FeedItem[] = sortedEvents
      .filter((ev) => ev.eventType === "spectator_chat")
      .slice(-100)
      .map(mapEventToFeed);

    const state: LiveGameState = {
      gameId: latestGame.id,
      roomId,
      roomCode,
      status: latestGame.status === "ended" ? "ended" : "active",
      currentTurnUserId: latestGame.currentTurnUserId,
      turnNumber: latestGame.turnNumber,
      turnDeadlineAt: null,
      turnTimerHandle: null,
      settings,
      players: livePlayers,
      feed,
      spectatorFeed,
      activeQuestion: null,
      questionsAskedThisTurn: 0,
      processedActionIds: new Set(),
      startedAt: latestGame.startedAt,
      endedAt: latestGame.endedAt,
    };

    this.liveGames.set(roomId, state);
    if (state.status === "active") {
      this.scheduleTurnTimer(state);
    }
    return state;
  }

  async startGame(params: {
    roomId: string;
    roomCode: string;
    settings: RoomSettings;
    members: Array<{
      userId: string;
      username: string;
      globalName: string | null;
      avatar: string | null;
      color: string;
    }>;
  }): Promise<LiveGameState> {
    if (params.members.length < 2) {
      throw new BadRequestError(
        "At least 2 players are required to start a match",
      );
    }

    // Clear previous timer if any
    const prev = this.liveGames.get(params.roomId);
    if (prev?.turnTimerHandle) {
      clearTimeout(prev.turnTimerHandle);
    }

    // Fetch eligible operator pool
    let pool = await OperatorsRepository.findMany({
      rarities: params.settings.operatorPool.rarities,
      classes: params.settings.operatorPool.classes,
    });

    if (pool.length < params.members.length) {
      // Fallback to all enabled operators if filters are too narrow
      pool = await OperatorsRepository.findMany({});
    }

    if (pool.length < params.members.length) {
      throw new BadRequestError(
        "Not enough seeded Operators in database. Run `bun run db:seed` first.",
      );
    }

    const chosenOperators = shuffle(pool).slice(0, params.members.length);
    const orderedMembers = shuffle(params.members);
    const firstTurnUser = orderedMembers[0]!;

    const gameId = crypto.randomUUID();
    const now = new Date();

    await db.insert(games).values({
      id: gameId,
      roomId: params.roomId,
      status: "active",
      currentTurnUserId: firstTurnUser.userId,
      turnNumber: 1,
      startedAt: now,
    });

    const livePlayers: LivePlayerState[] = [];
    for (let i = 0; i < orderedMembers.length; i++) {
      const m = orderedMembers[i]!;
      const op = chosenOperators[i]!;
      const gpId = crypto.randomUUID();

      await db.insert(gamePlayers).values({
        id: gpId,
        gameId,
        userId: m.userId,
        operatorId: op.id,
        seatOrder: i,
        livesRemaining: params.settings.lives,
      });

      livePlayers.push({
        id: gpId,
        userId: m.userId,
        username: m.username,
        globalName: m.globalName,
        avatar: m.avatar,
        color: m.color,
        seatOrder: i,
        operator: toPublicOperatorCard(op),
        livesRemaining: params.settings.lives,
        guessedAt: null,
        eliminatedAt: null,
      });
    }

    await db
      .update(rooms)
      .set({ status: "playing" })
      .where(eq(rooms.id, params.roomId));

    const startItem: FeedItem = {
      id: crypto.randomUUID(),
      type: "system",
      userId: null,
      username: SYSTEM_NAME,
      text: `Match initialized. ${orderedMembers.length} Operators assigned. Turn 1: ${firstTurnUser.globalName || firstTurnUser.username}.`,
      createdAt: now.toISOString(),
    };

    await this.recordEvent(gameId, null, "system", {
      username: SYSTEM_NAME,
      text: startItem.text,
    });

    const state: LiveGameState = {
      gameId,
      roomId: params.roomId,
      roomCode: params.roomCode,
      status: "active",
      currentTurnUserId: firstTurnUser.userId,
      turnNumber: 1,
      turnDeadlineAt: null,
      turnTimerHandle: null,
      settings: params.settings,
      players: livePlayers,
      feed: [startItem],
      spectatorFeed: [],
      activeQuestion: null,
      questionsAskedThisTurn: 0,
      processedActionIds: new Set(),
      startedAt: now,
      endedAt: null,
    };

    this.liveGames.set(params.roomId, state);
    this.scheduleTurnTimer(state);

    realtimeHub.broadcastPersonalizedGameState(
      params.roomId,
      "game:started",
      (viewerId) => this.getPersonalizedState(params.roomId, viewerId),
    );

    return state;
  }

  private scheduleTurnTimer(state: LiveGameState) {
    if (state.turnTimerHandle) {
      clearTimeout(state.turnTimerHandle);
      state.turnTimerHandle = null;
    }

    const seconds = state.settings.turnTimerSeconds;
    if (!seconds || seconds <= 0 || state.status !== "active") {
      state.turnDeadlineAt = null;
      return;
    }

    state.turnDeadlineAt = new Date(Date.now() + seconds * 1000);
    const expectedTurn = state.turnNumber;

    state.turnTimerHandle = setTimeout(() => {
      if (state.status !== "active" || state.turnNumber !== expectedTurn) return;
      void this.advanceTurn(state, "Turn timer expired. Advancing turn.");
    }, seconds * 1000);
  }

  private getEligiblePlayers(state: LiveGameState): LivePlayerState[] {
    return state.players
      .filter((p) => p.guessedAt === null && p.eliminatedAt === null)
      .sort((a, b) => a.seatOrder - b.seatOrder);
  }

  private async checkAndFinalizeIfEnded(state: LiveGameState): Promise<boolean> {
    const remaining = this.getEligiblePlayers(state);
    if (remaining.length > 0) return false;

    state.status = "ended";
    state.currentTurnUserId = null;
    state.endedAt = new Date();
    state.activeQuestion = null;
    if (state.turnTimerHandle) {
      clearTimeout(state.turnTimerHandle);
      state.turnTimerHandle = null;
    }
    state.turnDeadlineAt = null;

    const endItem: FeedItem = {
      id: crypto.randomUUID(),
      type: "system",
      userId: null,
      username: SYSTEM_NAME,
      text: "Operation complete. All Operator identities have been declassified.",
      createdAt: state.endedAt.toISOString(),
    };
    state.feed.push(endItem);

    await db
      .update(games)
      .set({
        status: "ended",
        currentTurnUserId: null,
        endedAt: state.endedAt,
      })
      .where(eq(games.id, state.gameId));

    await db
      .update(rooms)
      .set({ status: "finished" })
      .where(eq(rooms.id, state.roomId));

    await this.recordEvent(state.gameId, null, "system", {
      username: SYSTEM_NAME,
      text: endItem.text,
    });

    realtimeHub.broadcastPersonalizedGameState(
      state.roomId,
      "game:ended",
      (viewerId) => this.getPersonalizedState(state.roomId, viewerId),
    );

    return true;
  }

  private async advanceTurn(state: LiveGameState, systemReason?: string) {
    const ended = await this.checkAndFinalizeIfEnded(state);
    if (ended) return;

    const sorted = state.players
      .slice()
      .sort((a, b) => a.seatOrder - b.seatOrder);
    const currentIndex = sorted.findIndex(
      (p) => p.userId === state.currentTurnUserId,
    );

    let nextPlayer: LivePlayerState | null = null;
    for (let offset = 1; offset <= sorted.length; offset++) {
      const candidate = sorted[(currentIndex + offset) % sorted.length]!;
      if (candidate.guessedAt === null && candidate.eliminatedAt === null) {
        nextPlayer = candidate;
        break;
      }
    }

    if (!nextPlayer) {
      await this.checkAndFinalizeIfEnded(state);
      return;
    }

    state.currentTurnUserId = nextPlayer.userId;
    state.turnNumber += 1;
    state.activeQuestion = null;
    state.questionsAskedThisTurn = 0;

    if (systemReason) {
      const sysItem: FeedItem = {
        id: crypto.randomUUID(),
        type: "system",
        userId: null,
        username: SYSTEM_NAME,
        text: `${systemReason} Now active: ${nextPlayer.globalName || nextPlayer.username}.`,
        createdAt: new Date().toISOString(),
      };
      state.feed.push(sysItem);
    }

    await db
      .update(games)
      .set({
        currentTurnUserId: state.currentTurnUserId,
        turnNumber: state.turnNumber,
      })
      .where(eq(games.id, state.gameId));

    this.scheduleTurnTimer(state);

    realtimeHub.broadcast(state.roomId, "game:turn-changed", {
      currentTurnUserId: state.currentTurnUserId,
      turnNumber: state.turnNumber,
      turnDeadlineAt: state.turnDeadlineAt
        ? state.turnDeadlineAt.toISOString()
        : null,
    });

    realtimeHub.broadcastPersonalizedGameState(
      state.roomId,
      "game:state",
      (viewerId) => this.getPersonalizedState(state.roomId, viewerId),
    );
  }

  async handleChat(
    roomId: string,
    user: { userId: string; displayName: string },
    message: string,
  ) {
    const state = this.liveGames.get(roomId);

    if (state && state.status === "active") {
      const isPlayer = state.players.some((p) => p.userId === user.userId);
      if (!isPlayer) {
        throw new ForbiddenError(
          "Spectators can only chat in the spectator chat box",
        );
      }

      if (state.currentTurnUserId === user.userId) {
        await this.handleAsk(roomId, user, message);
        return;
      }
    }

    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "chat",
      userId: user.userId,
      username: user.displayName,
      text: message,
      createdAt: new Date().toISOString(),
    };

    if (!state) {
      this.pushLobbyChat(roomId, item);
      realtimeHub.broadcast(roomId, "room:chat", item);
      return;
    }

    state.feed.push(item);
    await this.recordEvent(state.gameId, user.userId, "chat", {
      username: user.displayName,
      text: message,
    });

    realtimeHub.broadcastPersonalizedGameState(
      roomId,
      "game:state",
      (viewerId) => this.getPersonalizedState(roomId, viewerId),
    );
  }

  async handleSpectatorChat(
    roomId: string,
    user: { userId: string; displayName: string },
    message: string,
  ) {
    const state = this.liveGames.get(roomId);
    if (!state) {
      throw new BadRequestError("No active game in this room");
    }

    const isPlayer = state.players.some((p) => p.userId === user.userId);
    if (isPlayer) {
      throw new ForbiddenError("Only spectators can use spectator chat");
    }

    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "spectator_chat",
      userId: user.userId,
      username: user.displayName,
      text: message,
      createdAt: new Date().toISOString(),
    };

    state.spectatorFeed.push(item);
    await this.recordEvent(state.gameId, user.userId, "spectator_chat", {
      username: user.displayName,
      text: message,
    });

    // Broadcast strictly to spectator sockets only; players receive nothing.
    realtimeHub.broadcastPersonalizedGameState(
      roomId,
      "game:state",
      (viewerId) => {
        const viewerIsPlayer = state.players.some((p) => p.userId === viewerId);
        if (viewerIsPlayer) return null;
        return this.getPersonalizedState(roomId, viewerId);
      },
    );
  }

  async handleClue(
    roomId: string,
    user: { userId: string; displayName: string },
    clue: { targetUserId?: string; attribute: string; value: string },
  ) {
    const state = this.liveGames.get(roomId);
    if (!state || state.status !== "active") {
      throw new BadRequestError("Clues can only be sent during an active game");
    }

    const target = clue.targetUserId
      ? state.players.find((p) => p.userId === clue.targetUserId)
      : state.players.find((p) => p.userId === state.currentTurnUserId);

    const targetLabel = target
      ? target.globalName || target.username
      : "Active Player";

    const label = `[CLUE -> ${targetLabel} | ${clue.attribute.toUpperCase()}] ${clue.value}`;

    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "clue",
      userId: user.userId,
      username: user.displayName,
      text: label,
      meta: {
        targetUserId: target?.userId ?? null,
        targetName: targetLabel,
        attribute: clue.attribute,
        value: clue.value,
      },
      createdAt: new Date().toISOString(),
    };

    state.feed.push(item);
    await this.recordEvent(state.gameId, user.userId, "clue", {
      username: user.displayName,
      text: label,
      ...item.meta,
    });

    realtimeHub.broadcastPersonalizedGameState(
      roomId,
      "game:state",
      (viewerId) => this.getPersonalizedState(roomId, viewerId),
    );
  }

  async handleAsk(
    roomId: string,
    user: { userId: string; displayName: string },
    question: string,
  ) {
    const state = this.liveGames.get(roomId);
    if (!state || state.status !== "active") {
      throw new BadRequestError("No active game in this room");
    }

    if (state.currentTurnUserId !== user.userId) {
      throw new ForbiddenError("Only the active turn player can ask a formal question");
    }

    if (state.questionsAskedThisTurn >= state.settings.maxQuestionsPerTurn) {
      throw new BadRequestError(
        `Question limit (${state.settings.maxQuestionsPerTurn}) reached for this turn. Guess or pass.`,
      );
    }

    const qId = crypto.randomUUID();
    const now = new Date().toISOString();
    state.activeQuestion = {
      id: qId,
      askerUserId: user.userId,
      askerName: user.displayName,
      question,
      answers: {},
      createdAt: now,
    };
    state.questionsAskedThisTurn += 1;

    const item: FeedItem = {
      id: qId,
      type: "question",
      userId: user.userId,
      username: user.displayName,
      text: question,
      meta: { questionId: qId },
      createdAt: now,
    };
    state.feed.push(item);

    await this.recordEvent(state.gameId, user.userId, "question", {
      username: user.displayName,
      text: question,
      questionId: qId,
    });

    realtimeHub.broadcastPersonalizedGameState(
      roomId,
      "game:state",
      (viewerId) => this.getPersonalizedState(roomId, viewerId),
    );
  }

  async handleAnswer(
    roomId: string,
    user: { userId: string; displayName: string },
    questionId: string,
    answer: "yes" | "no" | "unsure",
  ) {
    const state = this.liveGames.get(roomId);
    if (!state || state.status !== "active") {
      throw new BadRequestError("No active game");
    }

    if (!state.players.some((p) => p.userId === user.userId)) {
      throw new ForbiddenError("Spectators cannot vote on player questions");
    }

    if (!state.activeQuestion || state.activeQuestion.id !== questionId) {
      throw new NotFoundError("No matching active question");
    }

    if (state.activeQuestion.askerUserId === user.userId) {
      throw new ForbiddenError("You cannot answer your own question");
    }

    state.activeQuestion.answers[user.userId] = {
      username: user.displayName,
      value: answer,
    };

    const labelMap = { yes: "YES", no: "NO", unsure: "NOT SURE" };
    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "answer",
      userId: user.userId,
      username: user.displayName,
      text: `Answered [${labelMap[answer]}] to "${state.activeQuestion.question}"`,
      meta: { questionId, answer },
      createdAt: new Date().toISOString(),
    };
    state.feed.push(item);

    await this.recordEvent(state.gameId, user.userId, "answer", {
      username: user.displayName,
      text: item.text,
      questionId,
      answer,
    });

    realtimeHub.broadcastPersonalizedGameState(
      roomId,
      "game:state",
      (viewerId) => this.getPersonalizedState(roomId, viewerId),
    );
  }

  async handleReaction(
    roomId: string,
    user: { userId: string; displayName: string },
    reaction: string,
  ) {
    const state = this.liveGames.get(roomId);
    const labelMap: Record<string, string> = {
      warm: "[WARM] Getting warmer!",
      cold: "[COLD] Way off track",
      close: "[CLOSE] Very close!",
      yes: "[YES] Confirmed",
      no: "[NO] Negative",
      thinking: "[THINK] Hmm...",
      applause: "[NICE] Well played!",
    };

    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "reaction",
      userId: user.userId,
      username: user.displayName,
      text: labelMap[reaction] || reaction,
      meta: { reaction },
      createdAt: new Date().toISOString(),
    };

    if (!state) {
      this.pushLobbyChat(roomId, item);
      realtimeHub.broadcast(roomId, "room:chat", item);
      return;
    }

    if (state.status === "active") {
      if (!state.players.some((p) => p.userId === user.userId)) {
        throw new ForbiddenError("Spectators cannot react in player chat");
      }
      if (state.currentTurnUserId === user.userId) {
        throw new ForbiddenError(
          "Active turn player cannot send quick reactions",
        );
      }
    }

    state.feed.push(item);
    realtimeHub.broadcastPersonalizedGameState(
      roomId,
      "game:state",
      (viewerId) => this.getPersonalizedState(roomId, viewerId),
    );
  }

  async handleGuess(
    roomId: string,
    user: { userId: string; displayName: string },
    operatorId: string,
    clientActionId?: string,
  ) {
    const state = this.liveGames.get(roomId);
    if (!state || state.status !== "active") {
      throw new BadRequestError("No active game in this room");
    }

    // Deduplicate retries / double-clicks so lives are never double-consumed
    if (clientActionId) {
      const dedupeKey = `${user.userId}:${clientActionId}`;
      if (state.processedActionIds.has(dedupeKey)) {
        return;
      }
      state.processedActionIds.add(dedupeKey);
    }

    if (state.currentTurnUserId !== user.userId) {
      throw new ForbiddenError("It is not your turn to guess");
    }

    const player = state.players.find((p) => p.userId === user.userId);
    if (!player) {
      throw new ForbiddenError("You are not a player in this match");
    }

    if (player.guessedAt || player.eliminatedAt) {
      throw new BadRequestError("You are no longer active in this match");
    }

    const guessedOp: Operator | undefined =
      await OperatorsRepository.findById(operatorId);
    if (!guessedOp) {
      throw new BadRequestError("Invalid Operator selected");
    }

    const isCorrect = player.operator.id === guessedOp.id;
    const now = new Date();

    if (isCorrect) {
      player.guessedAt = now;
      await db
        .update(gamePlayers)
        .set({ guessedAt: now })
        .where(
          and(
            eq(gamePlayers.gameId, state.gameId),
            eq(gamePlayers.userId, user.userId),
          ),
        );
    } else {
      player.livesRemaining = Math.max(0, player.livesRemaining - 1);
      if (player.livesRemaining === 0) {
        player.eliminatedAt = now;
      }

      await db
        .update(gamePlayers)
        .set({
          livesRemaining: player.livesRemaining,
          eliminatedAt: player.eliminatedAt,
        })
        .where(
          and(
            eq(gamePlayers.gameId, state.gameId),
            eq(gamePlayers.userId, user.userId),
          ),
        );
    }

    const text = isCorrect
      ? `CORRECT! Identified their Operator as ${guessedOp.name}!`
      : player.eliminatedAt
        ? `Guessed ${guessedOp.name} — INCORRECT. 0 lives remaining — ELIMINATED! (Was ${player.operator.name})`
        : `Guessed ${guessedOp.name} — INCORRECT. ${player.livesRemaining} ${player.livesRemaining === 1 ? "life" : "lives"} left.`;

    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "guess",
      userId: user.userId,
      username: user.displayName,
      text,
      meta: {
        guessedOperatorId: guessedOp.id,
        guessedOperatorName: guessedOp.name,
        correct: isCorrect,
        livesRemaining: player.livesRemaining,
        eliminated: Boolean(player.eliminatedAt),
      },
      createdAt: now.toISOString(),
    };
    state.feed.push(item);

    await this.recordEvent(state.gameId, user.userId, "guess", {
      username: user.displayName,
      text,
      ...item.meta,
    });

    realtimeHub.broadcast(roomId, "game:guess-result", {
      userId: user.userId,
      username: user.displayName,
      guessedOperatorName: guessedOp.name,
      correct: isCorrect,
      livesRemaining: player.livesRemaining,
      eliminated: Boolean(player.eliminatedAt),
      revealedOperator:
        isCorrect || player.eliminatedAt ? player.operator : null,
    });

    await this.advanceTurn(state);
  }

  async handlePass(
    roomId: string,
    user: { userId: string; displayName: string },
    clientActionId?: string,
  ) {
    const state = this.liveGames.get(roomId);
    if (!state || state.status !== "active") {
      throw new BadRequestError("No active game in this room");
    }

    if (!state.settings.allowPass) {
      throw new BadRequestError("Passing turns is disabled in this room");
    }

    if (clientActionId) {
      const dedupeKey = `${user.userId}:${clientActionId}`;
      if (state.processedActionIds.has(dedupeKey)) {
        return;
      }
      state.processedActionIds.add(dedupeKey);
    }

    if (state.currentTurnUserId !== user.userId) {
      throw new ForbiddenError("It is not your turn");
    }

    const item: FeedItem = {
      id: crypto.randomUUID(),
      type: "system",
      userId: user.userId,
      username: user.displayName,
      text: `${user.displayName} passed their turn.`,
      createdAt: new Date().toISOString(),
    };
    state.feed.push(item);

    await this.recordEvent(state.gameId, user.userId, "pass", {
      username: user.displayName,
      text: item.text,
    });

    await this.advanceTurn(state);
  }

  private async recordEvent(
    gameId: string,
    userId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ) {
    await db.insert(gameEvents).values({
      id: crypto.randomUUID(),
      gameId,
      userId,
      eventType,
      payloadJson: payload,
    });
  }
}

export const gameEngine = new GameEngine();
