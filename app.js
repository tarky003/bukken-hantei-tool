'use strict';

/* ---------- storage ---------- */
const STORAGE_KEY = 'propertyJudgeTool.properties';
const SETTINGS_KEY = 'propertyJudgeTool.settings';

function loadProperties() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function saveProperties(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}
function loadSettings() {
  try {
    return Object.assign({ selfFundRatio: 20 }, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
  } catch (e) {
    return { selfFundRatio: 20 };
  }
}
function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

let properties = loadProperties();
let settings = loadSettings();
let editingId = null; // null = new property
let openDetailIds = new Set();
let footprintFieldEstimated = false; // 建築面積欄が自動推定値かどうか(手入力で解除)
let coverageFieldEstimated = false;  // 建蔽率欄が用途地域からの推定値かどうか
let farFieldEstimated = false;       // 容積率欄が用途地域からの推定値かどうか
let useZoneParsed = '';              // 直近に解析した用途地域名

/* ---------- 用途地域→標準的な建蔽率・容積率 ---------- */
// 各用途地域で最も一般的に指定される建蔽率(%)・容積率(%)。
// 実際は市区町村が地区ごとに指定するため、あくまで代表値(推定)。
// 判定順は具体的なものから先に(「準工業」を「工業」より前、「近隣商業」を「商業」より前 等)。
const USE_ZONE_TABLE = [
  { re: /第?[一１]種低層住居専用|[１1]種低層|１低|1低/, cov: 50, far: 100, label: '第一種低層住居専用地域' },
  { re: /第?[二２]種低層住居専用|[２2]種低層|２低|2低/, cov: 50, far: 100, label: '第二種低層住居専用地域' },
  { re: /田園住居/, cov: 50, far: 100, label: '田園住居地域' },
  { re: /第?[一１]種中高層住居専用|[１1]種中高|１中高|1中高/, cov: 60, far: 200, label: '第一種中高層住居専用地域' },
  { re: /第?[二２]種中高層住居専用|[２2]種中高|２中高|2中高/, cov: 60, far: 200, label: '第二種中高層住居専用地域' },
  { re: /第?[一１]種住居|[１1]種住居|１種住|1種住/, cov: 60, far: 200, label: '第一種住居地域' },
  { re: /第?[二２]種住居|[２2]種住居|２種住|2種住/, cov: 60, far: 200, label: '第二種住居地域' },
  { re: /準住居/, cov: 60, far: 200, label: '準住居地域' },
  { re: /近隣商業/, cov: 80, far: 200, label: '近隣商業地域' },
  { re: /商業地域|商業/, cov: 80, far: 400, label: '商業地域' },
  { re: /準工業/, cov: 60, far: 200, label: '準工業地域' },
  { re: /工業専用/, cov: 60, far: 200, label: '工業専用地域' },
  { re: /工業地域|工業/, cov: 60, far: 200, label: '工業地域' }
];

function lookupUseZone(text) {
  for (const z of USE_ZONE_TABLE) {
    if (z.re.test(text)) return z;
  }
  return null;
}

/* ---------- parsing ---------- */
function parseListingText(text) {
  const result = {};

  const grab = (patterns) => {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return '';
  };

  // 住所は空白以降にサイトの飾り文言(「川越市の価格 相場」等)が続くことがあるため最初の空白で切る
  result.address = grab([/(?:所在地|住所)[:：]?\s*([^\n]+)/]).split(/[\s　]/)[0];
  result.structure = grab([/構造[:：]?\s*([^\n,、]+)/]);
  // 築年月の後ろに別項目のラベル(「階建 /」等)が続くことがあるため取り除く
  result.builtYear = grab([/(?:築年月|建築年月|完成時期)[:：]?\s*([^\n,、]+)/]).replace(/[\s　]*階建.*$/, '').trim();

  const priceStr = grab([/(?:価格|売買価格|販売価格)[:：]?\s*([\d,，]+)\s*万円/]);
  result.price = priceStr ? Number(priceStr.replace(/[,，]/g, '')) : '';

  // 諸費用は販売価格の7%(概算)を自動入力
  result.costs = result.price > 0 ? Math.round(result.price * 0.07) : '';

  const landStr = grab([/(?:土地面積|敷地面積)[:：]?\s*([\d,，.]+)\s*(?:m²|m2|㎡)/]);
  result.landArea = landStr ? Number(landStr.replace(/[,，]/g, '')) : '';

  const footprintStr = grab([/建築面積[:：]?\s*([\d,，.]+)\s*(?:m²|m2|㎡)/]);
  result.footprintArea = footprintStr ? Number(footprintStr.replace(/[,，]/g, '')) : '';

  const totalFloorStr = grab([/(?:延床面積|延べ床面積)[:：]?\s*([\d,，.]+)\s*(?:m²|m2|㎡)/, /建物面積[:：]?\s*([\d,，.]+)\s*(?:m²|m2|㎡)/]);
  result.totalFloorArea = totalFloorStr ? Number(totalFloorStr.replace(/[,，]/g, '')) : '';

  // 地上階数(建築面積が未記載のとき延床面積÷階数で推定するために使用)
  const toHalf = (s) => s.replace(/[０-９]/g, c => '０１２３４５６７８９'.indexOf(c));
  const floorsStr = grab([
    /([0-9０-９]+)\s*階\s*建/,
    /地上\s*([0-9０-９]+)\s*階/,
    /階建[^0-9０-９\n]{0,10}([0-9０-９]+)\s*階/,
    /階数[:：]?\s*([0-9０-９]+)/
  ]);
  if (floorsStr) {
    result.floors = Number(toHalf(floorsStr));
  } else if (/平屋/.test(text)) {
    result.floors = 1;
  } else {
    result.floors = '';
  }

  // 建築面積の記載がなく、延床面積と階数が分かる場合は「延床÷階数」で推定して入力
  if (!result.footprintArea && result.totalFloorArea > 0 && result.floors > 0) {
    result.footprintArea = Math.round((result.totalFloorArea / result.floors) * 100) / 100;
    result.footprintEstimated = true;
  }

  // combined 建ぺい率／容積率 pattern
  const combined = text.match(/建(?:ぺい|蔽)率\s*[／\/]\s*容積率[:：]?\s*([\d.]+)\s*%\s*[／\/]\s*([\d.]+)\s*%/);
  if (combined) {
    result.coverageDesignated = Number(combined[1]);
    result.farDesignated = Number(combined[2]);
  } else {
    const cov = grab([/(?:建ぺい率|建蔽率)[:：]?\s*([\d.]+)\s*%/]);
    const far = grab([/容積率[:：]?\s*([\d.]+)\s*%/]);
    result.coverageDesignated = cov ? Number(cov) : '';
    result.farDesignated = far ? Number(far) : '';
  }

  // 用途地域を読み取り、建蔽率・容積率が未記載なら用途地域の標準値で推定
  const zone = lookupUseZone(text);
  if (zone) {
    result.useZone = zone.label;
    if (!(result.coverageDesignated > 0)) {
      result.coverageDesignated = zone.cov;
      result.coverageEstimated = true;
    }
    if (!(result.farDesignated > 0)) {
      result.farDesignated = zone.far;
      result.farEstimated = true;
    }
  }

  result.cityPlanning = grab([/都市計画[:：]?\s*([^\n,、]+)/]);
  result.occupancy = grab([/(?:現況|入居状況)[:：]?\s*([^\n,、]+)/]);

  // 再建築不可(備考・接道欄などテキスト全体から検出)。「再建築可」は「建築不可」を含まないため誤検出しない
  result.notRebuildable = /再建築不可|建築不可/.test(text);

  // 物件種別(建て方): 統計相場の単価選択に使用
  if (/一戸建|１戸建|1戸建|戸建/.test(text)) {
    result.buildingType = 'house';
  } else if (/マンション|アパート|共同住宅|一棟|１棟|1棟/.test(text)) {
    result.buildingType = 'apartment';
  } else {
    result.buildingType = '';
  }

  return result;
}

/* ---------- filter logic ---------- */
function getExclusionReasons(p) {
  const reasons = [];
  const cp = (p.cityPlanning || '').trim();
  if (cp.includes('調整区域')) {
    reasons.push('都市計画が「市街化調整区域」(原則建築不可のため)');
  }
  if (p.notRebuildable) {
    reasons.push('再建築不可の物件');
  }
  const occ = (p.occupancy || '');
  if (occ.includes('居住中')) {
    reasons.push('現況が「居住中」');
  }
  return reasons;
}

/* ---------- ratio (建蔽率/容積率) check ---------- */
function checkRatios(p) {
  const out = { coverage: null, far: null };

  // 建築面積が未記載の場合は延床面積÷階数で推定(各階同面積と仮定した概算)
  let footprint = p.footprintArea > 0 ? p.footprintArea : 0;
  let footprintEstimated = !!p.footprintEstimated && footprint > 0;
  if (!footprint && p.totalFloorArea > 0 && p.floors > 0) {
    footprint = p.totalFloorArea / p.floors;
    footprintEstimated = true;
  }

  if (p.landArea > 0 && footprint > 0 && p.coverageDesignated > 0) {
    const actual = (footprint / p.landArea) * 100;
    out.coverage = {
      actual,
      designated: p.coverageDesignated,
      ok: actual <= p.coverageDesignated + 0.01,
      estimated: footprintEstimated,
      footprintUsed: footprint,
      designatedEstimated: !!p.coverageEstimated
    };
  }
  if (p.landArea > 0 && p.totalFloorArea > 0 && p.farDesignated > 0) {
    const actual = (p.totalFloorArea / p.landArea) * 100;
    out.far = {
      actual,
      designated: p.farDesignated,
      ok: actual <= p.farDesignated + 0.01,
      designatedEstimated: !!p.farEstimated
    };
  }

  // 建て替え・新築時に建てられる最大規模(参考)
  if (p.landArea > 0 && p.coverageDesignated > 0) {
    out.maxFootprint = p.landArea * (p.coverageDesignated / 100);
  }
  if (p.landArea > 0 && p.farDesignated > 0) {
    out.maxTotalFloor = p.landArea * (p.farDesignated / 100);
  }
  return out;
}

/* ---------- statistical rent lookup (住宅・土地統計調査) ---------- */
function findArea(address) {
  if (!address || typeof RENT_DB === 'undefined') return null;

  // 都道府県を特定(コード末尾000がその都道府県の行)
  let prefCode = null;
  for (const code in RENT_DB) {
    if (code.endsWith('000') && address.includes(RENT_DB[code].n)) {
      prefCode = code.slice(0, 2);
      break;
    }
  }

  // 市区町村を「住所に含まれる最長の地域名」で特定(都道府県が分かればその中だけ探す)
  let best = null;
  for (const code in RENT_DB) {
    if (code.endsWith('000')) continue;
    if (prefCode && !code.startsWith(prefCode)) continue;
    const name = RENT_DB[code].n;
    if (address.includes(name)) {
      if (!best || name.length > best.name.length) best = { code, name };
    }
  }
  return {
    city: best ? RENT_DB[best.code] : null,
    pref: prefCode ? RENT_DB[prefCode + '000'] : null
  };
}

function isWooden(structure) {
  const s = structure || '';
  if (/木造/.test(s)) return true;
  if (/鉄骨|鉄筋|RC|SRC|コンクリート|ブロック/.test(s)) return false;
  return null; // 不明
}

// 統計相場の㎡単価を選択。優先順: 市区町村の建て方×構造 → 都道府県の同区分 → 市区町村の民営借家 → 総数 → 都道府県の民営借家 → 総数
function statUnitRent(p) {
  const area = findArea(p.address);
  if (!area || (!area.city && !area.pref)) return null;

  const wood = isWooden(p.structure);
  let detailKey = null;
  let typeLabel = '';
  if (p.buildingType === 'house') {
    detailKey = wood === false ? 'hn' : 'hw';
    typeLabel = wood === false ? '一戸建(非木造)' : '一戸建(木造)';
  } else if (p.buildingType === 'apartment') {
    detailKey = wood === true ? 'aw' : 'an';
    typeLabel = wood === true ? '共同住宅(木造)' : '共同住宅(非木造)';
  }

  const candidates = [];
  if (detailKey) {
    if (area.city) candidates.push({ v: area.city[detailKey], label: `${area.city.n}・${typeLabel}` });
    if (area.pref) candidates.push({ v: area.pref[detailKey], label: `${area.pref.n}平均・${typeLabel}` });
  }
  if (area.city) {
    candidates.push({ v: area.city.m, label: `${area.city.n}・民営借家平均` });
    candidates.push({ v: area.city.t, label: `${area.city.n}・借家全体平均` });
  }
  if (area.pref) {
    candidates.push({ v: area.pref.m, label: `${area.pref.n}平均・民営借家` });
    candidates.push({ v: area.pref.t, label: `${area.pref.n}平均・借家全体` });
  }
  for (const c of candidates) {
    if (c.v > 0) return { yenPerM2: c.v, basisLabel: c.label };
  }
  return null;
}

/* ---------- rent estimation ---------- */
// 手入力の類似物件があればそれを優先し、無ければ統計相場から自動算出する
function estimateRent(p) {
  const basisArea = p.rentBasisArea > 0 ? p.rentBasisArea : (p.totalFloorArea || 0);

  const comps = (p.comps || []).filter(c => c.area > 0 && c.rent > 0);
  if (comps.length > 0) {
    const unitRents = comps.map(c => c.rent / c.area); // 万円/月/m2
    const avgUnitRent = unitRents.reduce((a, b) => a + b, 0) / unitRents.length;
    if (!basisArea) return { source: 'comps', avgUnitRent, basisArea: 0, monthlyRent: null, annualRent: null };
    const monthlyRent = avgUnitRent * basisArea;
    return { source: 'comps', avgUnitRent, basisArea, monthlyRent, annualRent: monthlyRent * 12 };
  }

  const stat = statUnitRent(p);
  if (stat) {
    const avgUnitRent = stat.yenPerM2 / 10000; // 円→万円
    if (!basisArea) return { source: 'stat', statBasis: stat.basisLabel, yenPerM2: stat.yenPerM2, avgUnitRent, basisArea: 0, monthlyRent: null, annualRent: null };
    const monthlyRent = avgUnitRent * basisArea;
    return { source: 'stat', statBasis: stat.basisLabel, yenPerM2: stat.yenPerM2, avgUnitRent, basisArea, monthlyRent, annualRent: monthlyRent * 12 };
  }

  return null;
}

/* ---------- yield ---------- */
function calcYield(p, rentInfo) {
  if (!rentInfo || !rentInfo.annualRent || !p.price) return null;
  const costs = p.costs > 0 ? p.costs : p.price * 0.07;
  const surfaceYield = (rentInfo.annualRent / p.price) * 100;
  const totalYield = (rentInfo.annualRent / (p.price + costs)) * 100;
  return { surfaceYield, totalYield, costsUsed: costs };
}

/* ---------- loan simulation (元金均等返済) ---------- */
const LOAN_RATE = 0.03;
const LOAN_YEARS = 10;

function buildLoanSchedule(loanAmount) {
  const months = LOAN_YEARS * 12;
  const monthlyPrincipal = loanAmount / months;
  const monthlyRate = LOAN_RATE / 12;
  let balance = loanAmount;
  let cumulative = 0;
  const rows = [];
  for (let m = 1; m <= months; m++) {
    const interest = balance * monthlyRate;
    const payment = monthlyPrincipal + interest;
    balance = Math.max(balance - monthlyPrincipal, 0);
    cumulative += payment;
    rows.push({ month: m, principal: monthlyPrincipal, interest, payment, cumulative, balance });
  }
  return rows;
}

function buildYearlySummary(monthlyRows) {
  const years = [];
  for (let y = 0; y < LOAN_YEARS; y++) {
    const slice = monthlyRows.slice(y * 12, y * 12 + 12);
    const principal = slice.reduce((a, r) => a + r.principal, 0);
    const interest = slice.reduce((a, r) => a + r.interest, 0);
    const payment = slice.reduce((a, r) => a + r.payment, 0);
    const endBalance = slice[slice.length - 1].balance;
    years.push({ year: y + 1, principal, interest, payment, endBalance });
  }
  return years;
}

/* ---------- formatting helpers ---------- */
const fmt = (n, digits = 0) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

/* ---------- rendering ---------- */
function render() {
  document.getElementById('selfFundRatio').value = settings.selfFundRatio;
  const list = document.getElementById('propertyList');
  list.innerHTML = '';

  if (properties.length === 0) {
    list.innerHTML = '<div class="empty-state">まだ物件が登録されていません。「＋ 物件を追加」から登録してください。</div>';
    return;
  }

  properties.forEach(p => {
    list.appendChild(renderCard(p));
  });
}

function renderCard(p) {
  const card = document.createElement('div');
  card.className = 'property-card';
  card.dataset.id = p.id;

  const reasons = getExclusionReasons(p);
  const excluded = reasons.length > 0;
  const ratios = checkRatios(p);
  const rentInfo = estimateRent(p);
  const yieldInfo = calcYield(p, rentInfo);

  const filterBadge = excluded
    ? `<span class="badge badge-ng">除外</span>`
    : `<span class="badge badge-ok">対象</span>`;

  let ratioBadge = `<span class="badge badge-muted">判定不可</span>`;
  if (ratios.coverage || ratios.far) {
    const bothOk = (!ratios.coverage || ratios.coverage.ok) && (!ratios.far || ratios.far.ok);
    ratioBadge = bothOk
      ? `<span class="badge badge-ok">適正</span>`
      : `<span class="badge badge-ng">超過あり</span>`;
  }

  const summary = document.createElement('div');
  summary.className = 'card-summary';
  summary.innerHTML = `
    <div class="card-summary-main">
      <div class="card-title">${escapeHtml(p.address || '(住所未入力)')}</div>
      <div class="card-sub">${escapeHtml(p.structure || '')} ${p.price ? '・' + fmt(p.price) + '万円' : ''}</div>
    </div>
    <div class="card-summary-metrics">
      <div class="metric"><div class="value">${filterBadge}</div><div class="label">フィルタ</div></div>
      <div class="metric"><div class="value">${ratioBadge}</div><div class="label">建蔽率/容積率</div></div>
      <div class="metric"><div class="value">${yieldInfo ? fmt(yieldInfo.surfaceYield, 1) + '%' : '-'}</div><div class="label">表面利回り</div></div>
    </div>
    <div class="card-actions">
      <button class="btn-secondary btn-small btn-edit">編集</button>
      <button class="btn-danger btn-delete">削除</button>
    </div>
  `;
  summary.addEventListener('click', (e) => {
    if (e.target.closest('.btn-edit') || e.target.closest('.btn-delete')) return;
    toggleDetail(p.id);
  });
  summary.querySelector('.btn-edit').addEventListener('click', () => openForm(p.id));
  summary.querySelector('.btn-delete').addEventListener('click', () => deleteProperty(p.id));

  card.appendChild(summary);

  const detail = document.createElement('div');
  detail.className = 'card-detail' + (openDetailIds.has(p.id) ? ' open' : '');
  detail.innerHTML = renderDetail(p, reasons, ratios, rentInfo, yieldInfo);
  card.appendChild(detail);

  return card;
}

function renderDetail(p, reasons, ratios, rentInfo, yieldInfo) {
  const loanAmount = (p.price || 0) * (1 - settings.selfFundRatio / 100);
  const monthlyRows = loanAmount > 0 ? buildLoanSchedule(loanAmount) : [];
  const yearlyRows = monthlyRows.length ? buildYearlySummary(monthlyRows) : [];

  const ratioRow = (label, r) => {
    if (!r) {
      const missing = [];
      if (!(p.landArea > 0)) missing.push('土地面積');
      if (label === '建蔽率') {
        if (!(p.coverageDesignated > 0)) missing.push('建蔽率(指定)');
        if (!(p.footprintArea > 0) && !(p.totalFloorArea > 0 && p.floors > 0)) missing.push('建築面積(または延床面積＋地上階数)');
      } else {
        if (!(p.farDesignated > 0)) missing.push('容積率(指定)');
        if (!(p.totalFloorArea > 0)) missing.push('延床面積');
      }
      return `<div><span class="k">${label}</span><span class="v">判定不可<br><span class="hint">「編集」で ${missing.join('・')} を入力すると判定できます</span></span></div>`;
    }
    const anyEstimated = r.estimated || r.designatedEstimated;
    const status = r.ok
      ? `<span class="badge badge-ok">適正${anyEstimated ? '(推定)' : ''}</span>`
      : `<span class="badge badge-ng">超過${anyEstimated ? '(推定)' : ''}</span>`;
    const notes = [];
    if (r.estimated) notes.push(`建築面積の記載がないため延床面積÷${fmt((p.floors || 0))}階=${fmt(r.footprintUsed, 1)}m²と推定`);
    if (r.designatedEstimated) notes.push(`指定${label}は物件情報に記載がないため用途地域「${escapeHtml(p.useZone || '')}」の標準値で推定`);
    const est = notes.length ? `<br><span class="hint">${notes.join('／')}</span>` : '';
    const dmark = r.designatedEstimated ? '※' : '';
    return `<div><span class="k">${label}</span><span class="v">実際 ${fmt(r.actual, 1)}% / 指定 ${fmt(r.designated, 1)}%${dmark} ${status}${est}</span></div>`;
  };

  return `
    <div class="detail-section">
      <h3>フィルタ判定</h3>
      ${reasons.length
        ? `<div class="badge badge-ng">除外対象</div><ul class="reason-list">${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : `<div class="badge badge-ok">除外条件に該当なし</div>`}
      <div class="kv-grid" style="margin-top:10px;">
        <div><span class="k">都市計画</span><span class="v">${escapeHtml(p.cityPlanning || '(未入力)')}</span></div>
        <div><span class="k">現況</span><span class="v">${escapeHtml(p.occupancy || '(未入力)')}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <h3>建蔽率・容積率の適正性(記載値ベースの簡易判定)</h3>
      <div class="kv-grid">
        ${ratioRow('建蔽率', ratios.coverage)}
        ${ratioRow('容積率', ratios.far)}
      </div>
      ${(ratios.maxFootprint || ratios.maxTotalFloor) ? `
      <div class="kv-grid" style="margin-top:10px;">
        <div><span class="k">建築可能な最大建築面積</span><span class="v">${ratios.maxFootprint ? fmt(ratios.maxFootprint, 1) + ' m²' : '-'}</span></div>
        <div><span class="k">建築可能な最大延床面積</span><span class="v">${ratios.maxTotalFloor ? fmt(ratios.maxTotalFloor, 1) + ' m²' : '-'}</span></div>
      </div>
      <p class="hint">土地面積×建蔽率／容積率で算出した、建て替え・新築時に建てられる規模の目安(参考値)。角地緩和・前面道路幅員による容積率制限などは考慮していません。</p>
      ` : ''}
    </div>

    <div class="detail-section">
      <h3>近隣家賃相場・想定家賃</h3>
      ${rentInfo && rentInfo.source === 'stat' ? `
      <div class="kv-grid">
        <div><span class="k">相場の根拠</span><span class="v">統計相場(${escapeHtml(rentInfo.statBasis)})</span></div>
        <div><span class="k">家賃㎡単価</span><span class="v">${fmt(rentInfo.yenPerM2)} 円/m²・月</span></div>
        <div><span class="k">算出基準面積</span><span class="v">${rentInfo.basisArea ? fmt(rentInfo.basisArea, 1) + ' m²' : '-(延床面積が未入力)'}</span></div>
        <div><span class="k">想定月額家賃</span><span class="v">${rentInfo.monthlyRent ? fmt(rentInfo.monthlyRent, 1) + ' 万円' : '-'}</span></div>
        <div><span class="k">想定年間家賃</span><span class="v">${rentInfo.annualRent ? fmt(rentInfo.annualRent, 1) + ' 万円' : '-'}</span></div>
      </div>
      <p class="hint">出典: 総務省「令和5年住宅・土地統計調査」の市区町村別平均家賃(住所から自動判定)。市区町村平均のため駅距離・築年数・設備は反映されません。精度を上げたい場合は編集画面で近隣の類似賃貸物件を入力すると、そちらが優先されます。</p>
      ` : `
      <table class="comp-table" data-role="comp-table-view">
        <thead><tr><th>住所/物件名</th><th>面積(m²)</th><th>家賃(万円/月)</th><th>㎡単価(万円)</th></tr></thead>
        <tbody>
          ${(p.comps || []).map(c => `<tr><td style="text-align:left">${escapeHtml(c.address || '')}</td><td>${fmt(c.area, 1)}</td><td>${fmt(c.rent, 2)}</td><td>${c.area > 0 ? fmt(c.rent / c.area, 4) : '-'}</td></tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#999;">類似物件が未登録で、住所から統計相場も判定できませんでした(住所に都道府県・市区町村名を含めてください)</td></tr>'}
        </tbody>
      </table>
      <div class="kv-grid" style="margin-top:10px;">
        <div><span class="k">相場の根拠</span><span class="v">${rentInfo ? '手入力の類似物件 ' + (p.comps || []).filter(c => c.area > 0 && c.rent > 0).length + '件' : '-'}</span></div>
        <div><span class="k">平均㎡単価</span><span class="v">${rentInfo && rentInfo.avgUnitRent ? fmt(rentInfo.avgUnitRent, 4) + ' 万円/m²' : '-'}</span></div>
        <div><span class="k">算出基準面積</span><span class="v">${rentInfo ? fmt(rentInfo.basisArea, 1) + ' m²' : '-'}</span></div>
        <div><span class="k">想定月額家賃</span><span class="v">${rentInfo && rentInfo.monthlyRent ? fmt(rentInfo.monthlyRent, 1) + ' 万円' : '-'}</span></div>
        <div><span class="k">想定年間家賃</span><span class="v">${rentInfo && rentInfo.annualRent ? fmt(rentInfo.annualRent, 1) + ' 万円' : '-'}</span></div>
      </div>
      `}
    </div>

    <div class="detail-section">
      <h3>想定利回り</h3>
      <div class="kv-grid">
        <div><span class="k">表面利回り</span><span class="v">${yieldInfo ? fmt(yieldInfo.surfaceYield, 2) + '%' : '-'}</span></div>
        <div><span class="k">総事業利回り(諸費用込み)</span><span class="v">${yieldInfo ? fmt(yieldInfo.totalYield, 2) + '%' : '-'}</span></div>
        <div><span class="k">使用した諸費用</span><span class="v">${yieldInfo ? fmt(yieldInfo.costsUsed, 1) + ' 万円' : '-'}</span></div>
      </div>
    </div>

    <div class="detail-section">
      <h3>ローンシミュレーション(金利3%・10年・元金均等返済)</h3>
      <div class="kv-grid">
        <div><span class="k">物件価格</span><span class="v">${fmt(p.price, 0)} 万円</span></div>
        <div><span class="k">自己資金割合</span><span class="v">${settings.selfFundRatio}%</span></div>
        <div><span class="k">借入額</span><span class="v">${fmt(loanAmount, 1)} 万円</span></div>
      </div>
      ${yearlyRows.length ? `
      <div class="year-table-wrap" style="margin-top:10px;">
        <table class="data-table">
          <thead><tr><th>年目</th><th>元金返済額</th><th>利息返済額</th><th>年間返済額</th><th>年末残高</th></tr></thead>
          <tbody>
            ${yearlyRows.map(y => `<tr><td>${y.year}年目</td><td>${fmt(y.principal, 1)}</td><td>${fmt(y.interest, 1)}</td><td>${fmt(y.payment, 1)}</td><td>${fmt(y.endBalance, 1)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="toggle-link" data-role="toggle-monthly">月次内訳(120回)を表示</div>
      <div class="year-table-wrap" data-role="monthly-wrap" style="display:none; margin-top:10px;">
        <table class="data-table">
          <thead><tr><th>回数</th><th>元金部分</th><th>利息部分</th><th>返済額</th><th>返済額累計</th><th>ローン残高</th></tr></thead>
          <tbody>
            ${monthlyRows.map(r => `<tr><td>${r.month}</td><td>${fmt(r.principal, 2)}</td><td>${fmt(r.interest, 2)}</td><td>${fmt(r.payment, 2)}</td><td>${fmt(r.cumulative, 2)}</td><td>${fmt(r.balance, 2)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      ` : '<p class="hint">価格が未入力のためシミュレーションできません。</p>'}
    </div>
  `;
}

function toggleDetail(id) {
  if (openDetailIds.has(id)) {
    openDetailIds.delete(id);
  } else {
    openDetailIds.add(id);
  }
  render();
  attachDetailHandlers();
}

function attachDetailHandlers() {
  document.querySelectorAll('[data-role="toggle-monthly"]').forEach(el => {
    el.addEventListener('click', () => {
      const wrap = el.nextElementSibling;
      const showing = wrap.style.display !== 'none';
      wrap.style.display = showing ? 'none' : 'block';
      el.textContent = showing ? '月次内訳(120回)を表示' : '月次内訳を閉じる';
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function deleteProperty(id) {
  if (!confirm('この物件を削除しますか？')) return;
  properties = properties.filter(p => p.id !== id);
  saveProperties(properties);
  render();
  attachDetailHandlers();
}

/* ---------- form ---------- */
function openForm(id) {
  editingId = id;
  const overlay = document.getElementById('formOverlay');
  const title = document.getElementById('formTitle');
  document.getElementById('rawText').value = '';
  clearCompRows();

  if (id) {
    const p = properties.find(x => x.id === id);
    title.textContent = '物件を編集';
    fillForm(p);
  } else {
    title.textContent = '物件を追加';
    fillForm({});
    addCompRow();
  }
  overlay.classList.remove('hidden');
}

function closeForm() {
  document.getElementById('formOverlay').classList.add('hidden');
  editingId = null;
}

function fillForm(p) {
  document.getElementById('f_address').value = p.address || '';
  document.getElementById('f_buildingType').value = p.buildingType || '';
  document.getElementById('f_structure').value = p.structure || '';
  document.getElementById('f_builtYear').value = p.builtYear || '';
  document.getElementById('f_price').value = p.price || '';
  document.getElementById('f_costs').value = p.costs || '';
  document.getElementById('f_landArea').value = p.landArea || '';
  document.getElementById('f_footprintArea').value = p.footprintArea || '';
  document.getElementById('f_floors').value = p.floors || '';
  document.getElementById('f_totalFloorArea').value = p.totalFloorArea || '';
  document.getElementById('f_coverageDesignated').value = p.coverageDesignated || '';
  document.getElementById('f_farDesignated').value = p.farDesignated || '';
  document.getElementById('f_cityPlanning').value = p.cityPlanning || '';
  document.getElementById('f_occupancy').value = p.occupancy || '';
  document.getElementById('f_rentBasisArea').value = p.rentBasisArea || '';
  document.getElementById('f_notRebuildable').checked = !!p.notRebuildable;
  footprintFieldEstimated = !!p.footprintEstimated;
  coverageFieldEstimated = !!p.coverageEstimated;
  farFieldEstimated = !!p.farEstimated;
  useZoneParsed = p.useZone || '';

  clearCompRows();
  (p.comps && p.comps.length ? p.comps : []).forEach(c => addCompRow(c));
}

function clearCompRows() {
  document.getElementById('compTableBody').innerHTML = '';
}

function addCompRow(comp) {
  const tbody = document.getElementById('compTableBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="comp-address" value="${comp ? escapeHtml(comp.address || '') : ''}"></td>
    <td><input type="number" step="0.01" class="comp-area" value="${comp ? (comp.area || '') : ''}"></td>
    <td><input type="number" step="0.01" class="comp-rent" value="${comp ? (comp.rent || '') : ''}"></td>
    <td><button type="button" class="btn-danger comp-remove">×</button></td>
  `;
  tr.querySelector('.comp-remove').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

function readCompRows() {
  return Array.from(document.querySelectorAll('#compTableBody tr')).map(tr => ({
    address: tr.querySelector('.comp-address').value.trim(),
    area: Number(tr.querySelector('.comp-area').value) || 0,
    rent: Number(tr.querySelector('.comp-rent').value) || 0
  })).filter(c => c.address || c.area || c.rent);
}

function saveForm() {
  const data = {
    id: editingId || ('p_' + Date.now()),
    address: document.getElementById('f_address').value.trim(),
    buildingType: document.getElementById('f_buildingType').value,
    structure: document.getElementById('f_structure').value.trim(),
    builtYear: document.getElementById('f_builtYear').value.trim(),
    price: Number(document.getElementById('f_price').value) || 0,
    costs: Number(document.getElementById('f_costs').value) || 0,
    landArea: Number(document.getElementById('f_landArea').value) || 0,
    footprintArea: Number(document.getElementById('f_footprintArea').value) || 0,
    floors: Number(document.getElementById('f_floors').value) || 0,
    totalFloorArea: Number(document.getElementById('f_totalFloorArea').value) || 0,
    coverageDesignated: Number(document.getElementById('f_coverageDesignated').value) || 0,
    farDesignated: Number(document.getElementById('f_farDesignated').value) || 0,
    cityPlanning: document.getElementById('f_cityPlanning').value.trim(),
    occupancy: document.getElementById('f_occupancy').value.trim(),
    notRebuildable: document.getElementById('f_notRebuildable').checked,
    rentBasisArea: Number(document.getElementById('f_rentBasisArea').value) || 0,
    comps: readCompRows()
  };
  data.footprintEstimated = footprintFieldEstimated && data.footprintArea > 0;
  data.coverageEstimated = coverageFieldEstimated && data.coverageDesignated > 0;
  data.farEstimated = farFieldEstimated && data.farDesignated > 0;
  data.useZone = useZoneParsed;

  if (editingId) {
    const idx = properties.findIndex(p => p.id === editingId);
    properties[idx] = data;
  } else {
    properties.push(data);
  }
  saveProperties(properties);
  closeForm();
  render();
  attachDetailHandlers();
}

/* ---------- init ---------- */
document.getElementById('btnNewProperty').addEventListener('click', () => openForm(null));
document.getElementById('btnCancel').addEventListener('click', closeForm);
document.getElementById('btnSave').addEventListener('click', saveForm);
document.getElementById('btnAddComp').addEventListener('click', () => addCompRow());
// 手入力したら該当の「推定値」フラグを解除(実測値として扱う)
document.getElementById('f_footprintArea').addEventListener('input', () => { footprintFieldEstimated = false; });
document.getElementById('f_coverageDesignated').addEventListener('input', () => { coverageFieldEstimated = false; });
document.getElementById('f_farDesignated').addEventListener('input', () => { farFieldEstimated = false; });
function applyParsedText(rawText) {
  const parsed = parseListingText(rawText);
  document.getElementById('f_address').value = parsed.address || '';
  document.getElementById('f_buildingType').value = parsed.buildingType || '';
  document.getElementById('f_structure').value = parsed.structure || '';
  document.getElementById('f_builtYear').value = parsed.builtYear || '';
  document.getElementById('f_price').value = parsed.price || '';
  document.getElementById('f_costs').value = parsed.costs || '';
  document.getElementById('f_landArea').value = parsed.landArea || '';
  document.getElementById('f_footprintArea').value = parsed.footprintArea || '';
  footprintFieldEstimated = !!parsed.footprintEstimated;
  document.getElementById('f_floors').value = parsed.floors || '';
  document.getElementById('f_totalFloorArea').value = parsed.totalFloorArea || '';
  document.getElementById('f_coverageDesignated').value = parsed.coverageDesignated || '';
  document.getElementById('f_farDesignated').value = parsed.farDesignated || '';
  coverageFieldEstimated = !!parsed.coverageEstimated;
  farFieldEstimated = !!parsed.farEstimated;
  useZoneParsed = parsed.useZone || '';
  document.getElementById('f_cityPlanning').value = parsed.cityPlanning || '';
  document.getElementById('f_occupancy').value = parsed.occupancy || '';
  document.getElementById('f_notRebuildable').checked = !!parsed.notRebuildable;
}

document.getElementById('btnParse').addEventListener('click', () => {
  applyParsedText(document.getElementById('rawText').value);
});

/* ---------- bookmarklet handoff ---------- */
function handlePrefillFromHash() {
  const hash = location.hash || '';
  const marker = '#prefill=';
  if (!hash.startsWith(marker)) return;

  const encoded = hash.slice(marker.length);
  history.replaceState(null, '', location.pathname + location.search);

  let text = '';
  try {
    text = decodeURIComponent(encoded);
  } catch (e) {
    alert('ブックマークレットから受け取ったデータの読み込みに失敗しました。');
    return;
  }

  openForm(null);
  document.getElementById('rawText').value = text;
  applyParsedText(text);
}
document.getElementById('selfFundRatio').addEventListener('change', (e) => {
  let v = Number(e.target.value);
  if (Number.isNaN(v) || v < 0) v = 0;
  if (v > 100) v = 100;
  settings.selfFundRatio = v;
  saveSettings(settings);
  render();
  attachDetailHandlers();
});

render();
attachDetailHandlers();
handlePrefillFromHash();
