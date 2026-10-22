import type { ChatInput, GiftInput, LikeInput, Viewer } from '../types.js';

type Any = Record<string, any>;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  if (typeof v === 'bigint') return Number(v);
  return undefined;
};
const text = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v.length) return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return undefined;
};

/**
 * Converte mensagens da biblioteca comunitária (tiktok-live-connector) para o contrato interno.
 * É o ÚNICO lugar que conhece o formato da biblioteca. Campos documentados no README da v2.5.0:
 *   gift: user.uniqueId/nickname, giftId, repeatCount, repeatEnd, giftDetails.giftType/giftName
 *   like: user, likeCount, totalLikeCount        chat: user, comment
 * Os aliases adicionais (common.msgId, groupId, userId/id, count/total, content) vêm dos tipos
 * protobuf (tiktok-live-proto) e NÃO foram validados contra uma transmissão real.
 */
export function viewerOf(d: Any): Viewer {
  const u: Any = d?.user ?? {};
  return { userId: text(u.userId) ?? text(u.id) ?? text(u.idStr), uniqueId: text(u.uniqueId), displayName: text(u.nickname) };
}

function common(d: Any) {
  const c: Any = d?.common ?? {};
  const ts = num(c.createTime) ?? num(d?.timestamp) ?? num(d?.createTime);
  return { eventId: text(d?.msgId) ?? text(c.msgId), ts };
}

export function normalizeGift(d: Any): GiftInput {
  const det: Any = d?.giftDetails ?? d?.gift ?? {};
  const giftType = num(det.giftType) ?? num(det.type);
  return {
    kind: 'gift', source: 'tiktok', simulated: false, ...common(d), viewer: viewerOf(d),
    giftId: text(d?.giftId) ?? text(det.id), giftName: text(det.giftName) ?? text(det.name) ?? text(d?.giftName),
    streakable: giftType === 1,
    repeatCount: num(d?.repeatCount) ?? num(d?.comboCount) ?? 1,
    repeatEnd: d?.repeatEnd === true || d?.repeatEnd === 1,
    groupId: text(d?.groupId),
  };
}

export function normalizeLike(d: Any): LikeInput {
  return { kind: 'like', source: 'tiktok', simulated: false, ...common(d), viewer: viewerOf(d), likeCount: num(d?.likeCount) ?? num(d?.count), totalLikeCount: num(d?.totalLikeCount) ?? num(d?.total) };
}

export function normalizeChat(d: Any): ChatInput {
  return { kind: 'chat', source: 'tiktok', simulated: false, ...common(d), viewer: viewerOf(d), text: text(d?.comment) ?? text(d?.content) ?? '' };
}
