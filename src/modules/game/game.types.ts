import type { Operator, RoomSettings } from "../../database";

export interface PublicOperatorCard {
  id: string;
  name: string;
  latinName: string | null;
  cnName: string;
  slug: string;
  rarity: number;
  operatorClass: string;
  branch: string;
  faction: string | null;
  factionLogoUrl: string | null;
  imageUrl: string;
}

export interface RoomMemberSummary {
  userId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  role: string;
  color: string;
  isReady: boolean;
  isOnline: boolean;
}

export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  hostUserId: string;
  hostName: string;
  status: string;
  hasPassword: boolean;
  playerCount: number;
  maxPlayers: number;
  settings: RoomSettings;
  createdAt: string;
}

export interface RoomDetail extends RoomSummary {
  members: RoomMemberSummary[];
  activeGameId: string | null;
  roomPassword?: string | null;
}

export interface FeedItem {
  id: string;
  type:
    | "chat"
    | "clue"
    | "question"
    | "answer"
    | "reaction"
    | "guess"
    | "system"
    | "spectator_chat";
  userId: string | null;
  username: string;
  text: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface ActiveQuestion {
  id: string;
  askerUserId: string;
  askerName: string;
  question: string;
  answers: Record<string, { username: string; value: "yes" | "no" | "unsure" }>;
  createdAt: string;
}

export interface PersonalizedGamePlayer {
  userId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  color: string;
  seatOrder: number;
  livesRemaining: number;
  guessedAt: string | null;
  eliminatedAt: string | null;
  isSelf: boolean;
  isTurn: boolean;
  operatorHidden: boolean;
  operator: PublicOperatorCard | null;
}

export interface PersonalizedGameState {
  gameId: string;
  roomId: string;
  roomCode: string;
  status: "active" | "ended";
  currentTurnUserId: string | null;
  turnNumber: number;
  turnDeadlineAt: string | null;
  settings: RoomSettings;
  players: PersonalizedGamePlayer[];
  isSpectator: boolean;
  feed: FeedItem[];
  spectatorFeed: FeedItem[];
  activeQuestion: ActiveQuestion | null;
  questionsAskedThisTurn: number;
  startedAt: string;
  endedAt: string | null;
}

export function toPublicOperatorCard(op: Operator): PublicOperatorCard {
  return {
    id: op.id,
    name: op.name,
    latinName: op.latinName,
    cnName: op.cnName,
    slug: op.slug,
    rarity: op.rarity,
    operatorClass: op.operatorClass,
    branch: op.branch,
    faction: op.faction,
    factionLogoUrl: op.factionLogoUrl,
    imageUrl: op.imageUrl,
  };
}
