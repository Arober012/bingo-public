export type BingoMode = 'normal' | 'rows' | 'corners' | 'blackout' | 'postage';

export interface BingoCardCell {
  value: string;
  free: boolean;
}

export interface BingoCard {
  id: string;
  size: number;
  freeCenter: boolean;
  cells: BingoCardCell[];
  signature: string;
}

export interface CreateCardConfig {
  size?: number;
  freeCenter?: boolean;
  random?: () => number;
  sessionId?: string;
  userId?: string;
  uniquenessSet?: Set<string>;
  maxAttempts?: number;
}

export type StampRejectionReason = 'index_out_of_range' | 'already_stamped' | 'option_not_called';

export interface StampValidationResult {
  ok: boolean;
  index: number;
  value?: string;
  reason?: StampRejectionReason;
}

const MODES: ReadonlySet<BingoMode> = new Set<BingoMode>(['normal', 'rows', 'corners', 'blackout', 'postage']);

function centerIndex(size: number): number {
  return Math.floor((size * size) / 2);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sanitizeIdPart(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const clean = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
  return clean.length > 0 ? clean : fallback;
}

function cellSignature(cells: BingoCardCell[]): string {
  return cells.map((cell) => (cell.free ? '__FREE__' : cell.value)).join('|');
}

function isStamped(card: BingoCard, stamps: Set<number>, index: number): boolean {
  if (stamps.has(index)) {
    return true;
  }

  return card.freeCenter && index === centerIndex(card.size);
}

function hasCompleteRow(card: BingoCard, stamps: Set<number>, row: number): boolean {
  for (let col = 0; col < card.size; col += 1) {
    if (!isStamped(card, stamps, row * card.size + col)) {
      return false;
    }
  }
  return true;
}

function hasCompleteColumn(card: BingoCard, stamps: Set<number>, col: number): boolean {
  for (let row = 0; row < card.size; row += 1) {
    if (!isStamped(card, stamps, row * card.size + col)) {
      return false;
    }
  }
  return true;
}

function hasCompleteMainDiagonal(card: BingoCard, stamps: Set<number>): boolean {
  for (let i = 0; i < card.size; i += 1) {
    if (!isStamped(card, stamps, i * card.size + i)) {
      return false;
    }
  }
  return true;
}

function hasCompleteAntiDiagonal(card: BingoCard, stamps: Set<number>): boolean {
  for (let i = 0; i < card.size; i += 1) {
    if (!isStamped(card, stamps, i * card.size + (card.size - 1 - i))) {
      return false;
    }
  }
  return true;
}

function hasAnyTwoByTwoBlock(card: BingoCard, stamps: Set<number>): boolean {
  if (card.size < 2) {
    return false;
  }

  for (let row = 0; row < card.size - 1; row += 1) {
    for (let col = 0; col < card.size - 1; col += 1) {
      const topLeft = row * card.size + col;
      const topRight = row * card.size + (col + 1);
      const bottomLeft = (row + 1) * card.size + col;
      const bottomRight = (row + 1) * card.size + (col + 1);

      if (
        isStamped(card, stamps, topLeft) &&
        isStamped(card, stamps, topRight) &&
        isStamped(card, stamps, bottomLeft) &&
        isStamped(card, stamps, bottomRight)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function normalizeMode(mode?: string): BingoMode {
  if (!mode) {
    return 'normal';
  }

  const normalized = mode.toLowerCase() as BingoMode;
  return MODES.has(normalized) ? normalized : 'normal';
}

export function getInitialStamps(card: BingoCard): Set<number> {
  const stamps = new Set<number>();
  if (card.freeCenter) {
    stamps.add(centerIndex(card.size));
  }
  return stamps;
}

export function createRandomCard(optionPool: string[], config: CreateCardConfig = {}): BingoCard {
  const size = config.size ?? 5;
  const freeCenter = config.freeCenter ?? true;
  const random = config.random ?? Math.random;
  const maxAttempts = config.maxAttempts ?? 200;
  const requiredOptions = (size * size) - (freeCenter ? 1 : 0);

  const uniqueOptions = [...new Set(optionPool.map((option) => option.trim()).filter(Boolean))];
  if (uniqueOptions.length < requiredOptions) {
    throw new Error(`Not enough options to build a ${size}x${size} card.`);
  }

  const cardIdPrefix = `${sanitizeIdPart(config.sessionId, 'session')}_${sanitizeIdPart(config.userId, 'user')}`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const sample = shuffle(uniqueOptions, random).slice(0, requiredOptions);
    const cells: BingoCardCell[] = [];
    const center = centerIndex(size);
    let pointer = 0;

    for (let i = 0; i < size * size; i += 1) {
      if (freeCenter && i === center) {
        cells.push({ value: 'FREE', free: true });
        continue;
      }

      cells.push({ value: sample[pointer], free: false });
      pointer += 1;
    }

    const signature = cellSignature(cells);
    if (config.uniquenessSet && config.uniquenessSet.has(signature)) {
      continue;
    }

    config.uniquenessSet?.add(signature);

    return {
      id: `${cardIdPrefix}_${Date.now().toString(36)}_${attempt}`,
      size,
      freeCenter,
      cells,
      signature,
    };
  }

  throw new Error('Failed to create a unique bingo card with current option constraints.');
}

export function applyStamp(
  card: BingoCard,
  stamps: Set<number>,
  index: number,
  calledOptions: Set<string>,
): StampValidationResult {
  if (index < 0 || index >= card.cells.length) {
    return {
      ok: false,
      index,
      reason: 'index_out_of_range',
    };
  }

  if (stamps.has(index)) {
    return {
      ok: false,
      index,
      reason: 'already_stamped',
    };
  }

  const cell = card.cells[index];
  if (!cell.free && !calledOptions.has(cell.value)) {
    return {
      ok: false,
      index,
      value: cell.value,
      reason: 'option_not_called',
    };
  }

  stamps.add(index);
  return {
    ok: true,
    index,
    value: cell.value,
  };
}

export function checkWin(mode: BingoMode, card: BingoCard, stamps: Set<number>): boolean {
  if (mode === 'corners') {
    const corners = [0, card.size - 1, card.size * (card.size - 1), card.size * card.size - 1];
    return corners.every((index) => isStamped(card, stamps, index));
  }

  if (mode === 'blackout') {
    for (let index = 0; index < card.cells.length; index += 1) {
      if (!isStamped(card, stamps, index)) {
        return false;
      }
    }
    return true;
  }

  const hasRow = (() => {
    for (let row = 0; row < card.size; row += 1) {
      if (hasCompleteRow(card, stamps, row)) {
        return true;
      }
    }
    return false;
  })();

  if (mode === 'rows') {
    return hasRow;
  }

  if (mode === 'postage') {
    return hasAnyTwoByTwoBlock(card, stamps);
  }

  if (hasRow) {
    return true;
  }

  for (let col = 0; col < card.size; col += 1) {
    if (hasCompleteColumn(card, stamps, col)) {
      return true;
    }
  }

  return hasCompleteMainDiagonal(card, stamps) || hasCompleteAntiDiagonal(card, stamps);
}
