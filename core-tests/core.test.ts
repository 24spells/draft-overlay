import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { distribution, gradeFromZ } from '../core/grades.ts';
import { cardRect, gridGeometry, positionCards } from '../core/layout.ts';
import { DraftTracker, parseLogLine } from '../core/log-parser.ts';
import { autoDeck, formatMetric, rateSet } from '../core/stats.ts';
import type { SetStats } from '../core/types.ts';

describe('grades', () => {
  it('puts an average card at C', () => {
    assert.equal(gradeFromZ(0), 'C');
  });

  it('matches the 17Lands band edges', () => {
    const edges: [number, string][] = [
      [2.18, 'A+'], [2.16, 'A'], [1.84, 'A'], [1.82, 'A-'], [1.51, 'A-'],
      [1.49, 'B+'], [1.18, 'B+'], [1.16, 'B'], [0.84, 'B'], [0.82, 'B-'],
      [0.51, 'B-'], [0.49, 'C+'], [0.18, 'C+'], [0.16, 'C'], [-0.16, 'C'],
      [-0.18, 'C-'], [-0.49, 'C-'], [-0.51, 'D+'], [-0.82, 'D+'],
      [-0.84, 'D'], [-1.16, 'D'], [-1.18, 'D-'], [-1.49, 'D-'], [-1.51, 'F'],
    ];
    for (const [z, grade] of edges) {
      assert.equal(gradeFromZ(z), grade, `z=${z}`);
    }
  });

  it('clamps the extremes', () => {
    assert.equal(gradeFromZ(9), 'A+');
    assert.equal(gradeFromZ(-9), 'F');
  });

  it('gives no distribution below 15 cards', () => {
    assert.equal(distribution(Array(14).fill(1)), null);
  });

  it('uses population standard deviation', () => {
    const result = distribution([...Array(8).fill(2), ...Array(8).fill(4)]);
    assert.deepEqual(result, { mean: 3, sd: 1 });
  });
});

function fakeSet(): SetStats {
  const names = Array.from({ length: 20 }, (_, i) => `Card ${i}`);
  return {
    set: 'TST',
    format: 'PremierDraft',
    source: { games: 1, drafts: 1, firstGame: '', lastGame: '', fileDate: null },
    names,
    cards: Object.fromEntries(
      names.map((name, n) => [
        String(1000 + n),
        { n, name, rarity: 'common', color: n < 10 ? 'U' : 'B', manaValue: 2, isLand: false },
      ]),
    ),
    groups: {
      'ALL|all': {
        games: 1,
        wins: 1,
        blocks: names.map((_, i) => [
          100, 50, 100, 50, 1000, 500 + i * 10, 2000, 1000, 400, 180,
        ]),
      },
    },
    picks: { all: names.map(() => [4.25, 10, 6.5, 10]) },
  };
}

describe('stats', () => {
  it('computes each metric from the counts', () => {
    const row = rateSet(fakeSet(), {
      deck: 'ALL', players: 'all', basis: 'gih', minGames: 500,
    }).get('Card 0')!;
    assert.equal(row.values.gih, 50);
    assert.equal(row.values.gns, 45);
    assert.equal(row.values.iwd, 5);
    assert.equal(row.values.gp, 50);
    assert.equal(row.values.ata, 4.25);
    assert.equal(row.values.alsa, 6.5);
  });

  it('grades the best card above the worst', () => {
    const rows = rateSet(fakeSet(), {
      deck: 'ALL', players: 'all', basis: 'gih', minGames: 500,
    });
    assert.ok(rows.get('Card 19')!.gradeIndex! > rows.get('Card 0')!.gradeIndex!);
  });

  it('leaves low-sample cards ungraded', () => {
    const row = rateSet(fakeSet(), {
      deck: 'ALL', players: 'all', basis: 'gih', minGames: 5000,
    }).get('Card 5')!;
    assert.equal(row.lowSample, true);
    assert.equal(row.grade, null);
  });

  it('treats a hidden win rate (wins -1, early website data) as no data, not 0%', () => {
    const set = fakeSet();
    set.groups['ALL|all'].blocks[3] = [254, -1, 200, -1, 454, -1, 1391, 748, 391, -1];
    const row = rateSet(set, { deck: 'ALL', players: 'all', basis: 'gih', minGames: 500 }).get('Card 3')!;
    assert.equal(row.values.gih, null);
    assert.equal(row.values.iwd, null);
    assert.equal(row.values.games, 454);
    assert.ok(Math.abs(row.values.gp! - 53.77) < 0.01);
    assert.equal(row.lowSample, true);
    assert.equal(row.grade, null);
  });

  it('returns blanks for a group with no data', () => {
    const row = rateSet(fakeSet(), {
      deck: 'WU', players: 'all', basis: 'gih', minGames: 0,
    }).get('Card 1')!;
    assert.equal(row.values.gih, null);
    assert.equal(formatMetric('gih', row.values.gih), '-');
  });

  it('waits for 6 colored picks before auto-matching', () => {
    const set = fakeSet();
    assert.equal(autoDeck(set, [1000, 1010, 1001, 1011, 1002]), null);
    assert.equal(autoDeck(set, [1000, 1010, 1001, 1011, 1002, 1012]), 'UB');
  });
});

describe('layout', () => {
  it('sorts by rarity, then color, and flows 5 across', () => {
    const cards = [
      { id: 1, rarity: 'common', color: 'G' },
      { id: 2, rarity: 'common', color: 'W' },
      { id: 3, rarity: 'rare', color: 'R' },
      { id: 4, rarity: 'uncommon', color: 'UB' },
      { id: 5, rarity: 'uncommon', color: 'B' },
      { id: 6, rarity: 'common', isLand: true, color: 'W' },
    ];
    const placed = positionCards(cards);
    assert.deepEqual(placed.map((p) => p.card.id), [3, 5, 4, 2, 1, 6]);
    assert.deepEqual([placed[5].column, placed[5].row], [0, 1]);
  });

  it('keeps unknown cards in the grid', () => {
    const placed = positionCards([{ id: 9 }, { id: 2, rarity: 'rare', color: 'U' }]);
    assert.deepEqual(placed.map((p) => p.card.id), [2, 9]);
  });

  it('scales with the window at 16:9', () => {
    const small = cardRect(1, 1, gridGeometry(1920, 1080));
    const large = cardRect(1, 1, gridGeometry(3840, 2160));
    assert.ok(Math.abs(large.left - small.left * 2) < 0.001);
    assert.ok(Math.abs(large.top - small.top * 2) < 0.001);
    assert.ok(Math.abs(large.width - small.width * 2) < 0.001);
  });
});

describe('log parsing', () => {
  it('reads a Premier pack', () => {
    const event = parseLogLine(
      '<x>,[UnityCrossThreadLogger]Draft.Notify {"draftId":"d1","SelfPick":2,"SelfPack":1,"PackCards":"11,22,33"}',
    );
    assert.deepEqual(event, {
      type: 'pack', format: null, draftId: 'd1', setCode: null,
      packNumber: 1, pickNumber: 2, cardIds: [11, 22, 33], pickedCardIds: null,
    });
  });

  it('reads a Quick pack and converts to 1-indexed', () => {
    const payload = JSON.stringify({
      EventName: 'QuickDraft_OTJ_20240426', DraftStatus: 'PickNext',
      PackNumber: 0, PickNumber: 1, DraftPack: ['10', '20'], PickedCards: ['5'],
    });
    const event = parseLogLine(JSON.stringify({ CurrentModule: 'BotDraft', Payload: payload }));
    assert.deepEqual(event, {
      type: 'pack', format: 'QuickDraft', draftId: null, setCode: 'OTJ',
      packNumber: 1, pickNumber: 2, cardIds: [10, 20], pickedCardIds: [5],
    });
  });

  it('accepts method names with and without underscores', () => {
    for (const name of ['EventPlayerDraftMakePick', 'Event_PlayerDraftMakePick']) {
      const request = JSON.stringify({ GrpIds: [77] });
      const event = parseLogLine(`[U]==> ${name} ${JSON.stringify({ request })}`);
      assert.deepEqual(event, { type: 'pick', cardIds: [77] });
    }
  });

  it('clears the pack after a pick and after the last pick', () => {
    const tracker = new DraftTracker();
    tracker.apply({
      type: 'pack', format: null, draftId: 'd', setCode: null,
      packNumber: 3, pickNumber: 14, cardIds: [1], pickedCardIds: null,
    });
    assert.ok(tracker.view);
    tracker.apply({ type: 'pick', cardIds: [1] });
    assert.equal(tracker.view, null);
  });

  const logs = path.resolve(import.meta.dirname, '../saved-drafts');
  const stats = path.resolve(import.meta.dirname, '../card-data/FRA.PremierDraft.json');

  it('replays real drafts completely', { skip: !existsSync(logs) || !existsSync(stats) }, () => {
    const set: SetStats = JSON.parse(readFileSync(stats, 'utf8'));
    const files = readdirSync(logs).filter((name) => name.startsWith('DraftLog_FRA_PremierDraft_'));
    assert.ok(files.length >= 3);

    for (const file of files) {
      const tracker = new DraftTracker();
      let packs = 0;
      for (const line of readFileSync(path.join(logs, file), 'utf8').split(/\r?\n/)) {
        const event = parseLogLine(line);
        if (!event) continue;
        tracker.apply(event);
        if (event.type === 'pack') {
          const view = tracker.view!;
          assert.equal(view.setCode, 'FRA');
          assert.equal(view.format, 'PremierDraft');
          assert.equal(view.pickedCardIds.length, packs, 'one pick recorded per pack');
          for (const id of view.cardIds) {
            assert.ok(set.cards[String(id)], `card ${id} has metadata`);
          }
          packs += 1;
        }
      }
      assert.equal(packs, 42, file);
      assert.equal(tracker.view, null, 'overlay clears after the last pick');
    }
  });
});
