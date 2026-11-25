import type { QuotaGroupView, QuotaWindowView } from '../lib/quota';
import { formatBarTitle, formatWeeklyAttributionInline } from '../lib/quota';
import type { ResolvedLocale } from '../lib/i18n';
import type { WeeklyPoolAttribution } from '../lib/types';
import { BrandIcons } from './ModelIcon';

function barTone(pct: number | null, stale: boolean): { fill: string; textColor: string } {
  if (pct === null) {
    return { fill: 'transparent', textColor: 'var(--text-secondary)' };
  }
  if (stale) {
    return { fill: 'var(--text-tertiary)', textColor: 'var(--warning)' };
  }
  if (pct <= 10) {
    return { fill: '#e03131', textColor: 'var(--danger)' };
  }
  if (pct <= 20) {
    return { fill: '#d97706', textColor: 'var(--warning)' };
  }
  return { fill: 'var(--blue-bright)', textColor: 'var(--text)' };
}

export function QuotaMeterRow({
  title,
  brands,
  showBrands = true,
  window: win,
  isDark,
  compact = false,
  poolKey,
  locale = 'zh-Hans',
  weeklyAttributionByPool,
}: {
  title: string;
  brands?: Array<'gemini' | 'claude' | 'openai'>;
  showBrands?: boolean;
  window: QuotaWindowView;
  isDark: boolean;
  compact?: boolean;
  poolKey?: string;
  locale?: ResolvedLocale;
  weeklyAttributionByPool?: ReadonlyMap<string, WeeklyPoolAttribution>;
}) {
  const { fill, textColor } = barTone(win.percentage, win.stale);
  const pct = win.percentage;
  const fillWidth = pct === null ? 0 : pct === 0 ? 0 : Math.max(2, Math.min(100, pct));
  const normalizedPoolKey = (poolKey ?? '').trim().toLowerCase();
  const weeklyPool =
    win.period.trim().toLowerCase() === 'weekly' && normalizedPoolKey && weeklyAttributionByPool
      ? weeklyAttributionByPool.get(normalizedPoolKey)
      : undefined;
  const weeklyInline = weeklyPool ? formatWeeklyAttributionInline(weeklyPool, locale) : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 4 : 5,
        minWidth: 0,
      }}
      title={win.unknownReason || undefined}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            flex: 1,
          }}
        >
          {showBrands && <BrandIcons brands={brands} fallbackName={title} size={compact ? 14 : 15} isDark={isDark} />}
          <span
            style={{
              fontSize: compact ? 12 : 12.5,
              fontWeight: 600,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            flexShrink: 0,
          }}
        >
          {win.resetText && (
            <span
              className="tabular"
              style={{
                fontSize: 11,
                color: win.stale ? 'var(--warning)' : 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              {win.resetText}
            </span>
          )}
          <span
            className="tabular"
            style={{
              fontSize: compact ? 12.5 : 13,
              fontWeight: 700,
              color: textColor,
              minWidth: 34,
              textAlign: 'right',
            }}
          >
            {pct !== null ? `${pct}%` : win.placeholder}
          </span>
        </div>
      </div>

      <div
        style={{
          height: compact ? 6 : 6.5,
          borderRadius: 999,
          background: 'var(--track)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {fillWidth > 0 && (
          <div
            style={{
              width: `${fillWidth}%`,
              height: '100%',
              borderRadius: 999,
              background: fill,
              transition: 'width 260ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        )}
      </div>

      {weeklyInline && (
        <div
          className="tabular"
          title={weeklyInline.tooltip}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6,
            fontSize: 10.5,
            lineHeight: 1.25,
            color: 'var(--text-secondary)',
            minWidth: 0,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              color: weeklyInline.state === 'calibrating' ? 'var(--warning)' : 'var(--text-secondary)',
            }}
          >
            {weeklyInline.left}
          </span>
          <span style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>{weeklyInline.right}</span>
        </div>
      )}
    </div>
  );
}

export function QuotaGroupsGrid({
  coreGroups,
  standaloneGroups,
  locale,
  isDark,
  compact = false,
  weeklyAttributionByPool,
}: {
  coreGroups: QuotaGroupView[];
  standaloneGroups: QuotaGroupView[];
  locale: ResolvedLocale;
  isDark: boolean;
  compact?: boolean;
  weeklyAttributionByPool?: ReadonlyMap<string, WeeklyPoolAttribution>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 9 : 11 }}>
      {coreGroups.map((group) => (
        <div
          key={group.key}
          style={{
            display: 'grid',
            gridTemplateColumns: group.windows.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr',
            gap: compact ? 12 : 16,
          }}
        >
          {group.windows.map((win) => (
            <QuotaMeterRow
              key={`${group.key}-${win.id}`}
              title={formatBarTitle(group, win, locale)}
              brands={group.brands}
              window={win}
              isDark={isDark}
              compact={compact}
              poolKey={group.key}
              locale={locale}
              weeklyAttributionByPool={weeklyAttributionByPool}
            />
          ))}
        </div>
      ))}

      {standaloneGroups.length > 0 && (
        <>
          {coreGroups.length > 0 && <div className="gb-divider" />}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: compact ? 12 : 16,
            }}
          >
            {standaloneGroups.map((group) =>
              group.windows.map((win) => (
                <QuotaMeterRow
                  key={`${group.key}-${win.id}`}
                  title={formatBarTitle(group, win, locale)}
                  brands={group.brands}
                  window={win}
                  isDark={isDark}
                  compact={compact}
                  poolKey={group.key}
                  locale={locale}
                  weeklyAttributionByPool={weeklyAttributionByPool}
                />
              )),
            )}
          </div>
        </>
      )}
    </div>
  );
}
