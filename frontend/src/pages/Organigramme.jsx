import React, { useState, useEffect, useRef } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { useSiteFilter } from '../contexts/SiteFilterContext';
import api, { employeesAPI, getCurrentUser, isGlobalHrManager } from '../services/api';
import {
  getEmployeeAvatarFallback,
  getEmployeeAvatarSrc,
  isTunisiaEmployeeRecord,
  formatEmployeeNom,
  formatEmployeePrenom
} from '../utils/employeeAvatar';
import { translateStsJobTitle, getEmployeeSite } from '../utils/employeeProfile';
import * as d3 from 'd3';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  User,
  Briefcase,
  Mail,
  Phone,
  Users,
  Download,
  Printer,
  ChevronsDown,
  ChevronsUp
} from 'lucide-react';
import Sidebar from '../components/Sidebar';
import logo from '../components/logo-northwind-1.png';
import './Organigramme.css';

// "<tenant_schema>:<id>" -- an employee id is only unique within its tenant.
const employeeKey = (emp) => `${emp.tenant_schema || 'public'}:${emp.id}`;

const normalizeMail = (email) => (email || '').trim().toLowerCase();

// Plant-select value of the group chart (G7 / G6, see GET /org-chart/group).
const GROUP_CHART = '__group__';

// Text wrapped on whole words into at most `maxLines` lines.
const wrapText = (text, maxChars, maxLines) => {
  const out = [];
  let current = '';
  String(text || '').split(/\s+/).filter(Boolean).forEach((word) => {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current = `${current} ${word}`;
    else { out.push(current); current = word; }
  });
  if (current) out.push(current);
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, maxChars - 1)}…`;
    return kept;
  }
  return out;
};

// emp -> their manager among `list`: the KPI reporting line first (kpiParents,
// non-SAHEL), else the HR manager emails -- the same rule buildHierarchy uses.
const makeParentResolver = (list, kpiParents) => {
  const byKey = new Map(list.map((emp) => [employeeKey(emp), emp]));
  const byEmail = new Map();
  list.forEach((emp) => {
    const mail = normalizeMail(emp.adresse_mail);
    if (!mail) return;
    if (!byEmail.has(mail)) byEmail.set(mail, []);
    byEmail.get(mail).push(emp);
  });
  return (emp) => {
    // Placed by KPI (non-SAHEL): KPI decides alone -- no HR email fallback.
    if (kpiParents.has(employeeKey(emp))) {
      const kpiParent = kpiParents.get(employeeKey(emp));
      return kpiParent && kpiParent !== employeeKey(emp) && byKey.has(kpiParent) ? byKey.get(kpiParent) : null;
    }
    for (const mail of [emp.mail_responsable1, emp.mail_responsable2].map(normalizeMail)) {
      if (!mail) continue;
      const candidates = (byEmail.get(mail) || []).filter((c) => c !== emp);
      if (candidates.length) {
        return candidates.find((c) => normalizeMail(c.mail_responsable1) !== normalizeMail(c.adresse_mail) &&
          normalizeMail(c.mail_responsable2) !== normalizeMail(c.adresse_mail)) || candidates[0];
      }
    }
    return null;
  };
};

const Organigramme = () => {
  const { t } = useLanguage();
  // Every login type gets the chart (2026-10-26): /employees already
  // scopes the list -- group HR every tenant, local HR their own tenant, a
  // site-restricted account its sites. getEmployeeSite() collapses SAHEL's
  // internal department labels into one "Site-Sahel", as on the Team page.
  const isGroupHr = isGlobalHrManager(getCurrentUser());

  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const { siteFilter: plantFilter, setSiteFilter: setPlantFilter } = useSiteFilter();
  const [filteredEmployees, setFilteredEmployees] = useState([]);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [selectedNode, setSelectedNode] = useState(null);
  const [exporting, setExporting] = useState(false);
  // "<tenant_schema>:<id>" -> manager's key, from KPI reports_to (non-SAHEL
  // only, see GET /org-chart/links). Empty when KPI is unreachable.
  const [kpiParents, setKpiParents] = useState(() => new Map());
  // "<key>" -> KPI manager's key for everyone, SAHEL included -- what the
  // chart draws above the plant (the head's chain up to the CEO, managers
  // outside the site), not its structure.
  const [kpiBoss, setKpiBoss] = useState(() => new Map());
  // Group chart (2026-10-29): KPI's G7 / G6 roles instead of a
  // plant -- a local choice, so the Team page's shared site filter is untouched.
  const [groupView, setGroupView] = useState(false);
  const [groupNodes, setGroupNodes] = useState(null);
  const [groupError, setGroupError] = useState(false);
  useEffect(() => {
    if (!groupView || groupNodes) return;
    api.get('/org-chart/group')
      .then((response) => setGroupNodes(response.data || []))
      .catch(() => { setGroupError(true); setGroupNodes([]); });
  }, [groupView, groupNodes]);

  const svgRef = useRef();
  const zoomRef = useRef(null);
  const fitTransformRef = useRef(null);
  // Each manager's team opens from their box (2026-11-02): the chart
  // starts with the head and their direct team only. Keys of the open ones.
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  // the current zoom, kept when a team is opened or closed instead of re-fitting
  const viewRef = useRef(null);
  const keepViewRef = useRef(false);
  // logo as a data URL: an SVG exported to PDF / printed can't load a file URL
  const [logoData, setLogoData] = useState(null);
  useEffect(() => {
    fetch(logo).then((r) => r.blob()).then((blob) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    })).then(setLogoData).catch(() => {});
  }, []);
  const containerRef = useRef();
  const chartWrapperRef = useRef();
  // KPI-only managers (isExternal) are shown above a site, never as one
  const plantOptions = Array.from(new Set(employees.filter((employee) => !employee.isExternal)
    .map((employee) => getEmployeeSite(employee)).filter(Boolean)))
    .sort((a, b) => String(a).localeCompare(String(b)));
  const canFilterByPlant = plantOptions.length > 1;
  // Group HR sees ~2000 people across every tenant -- far too many for one
  // chart -- so it always shows one site (the first, until one is picked);
  // other logins can also show all their sites at once.
  const selectedPlant = isGroupHr && !plantOptions.includes(plantFilter)
    ? plantOptions[0] || ''
    : plantFilter;

  const cleanName = (prenom, nom) => {
    if (!prenom && !nom) return t('orgNoName');
    const removeAbbreviations = (str) => {
      if (!str) return '';
      let cleaned = str;
      // ✅ CHANGED: Also strip dotted abbreviations like M.F. M.L.L. M.M. at start or end
      cleaned = cleaned.replace(/^([A-ZÀ-Ÿ]\.){1,4}\s*/g, '');
      cleaned = cleaned.replace(/\s+([A-ZÀ-Ÿ]\.){1,4}$/g, '');
      cleaned = cleaned.replace(/\s+[A-ZÀ-Ÿ]{2,}$/g, '');
      cleaned = cleaned.replace(/[-–—]\s*[A-ZÀ-Ÿ]{2,}$/g, '');
      cleaned = cleaned.replace(/\s+[A-ZÀ-Ÿ]{2,}\s+/g, ' ');
      cleaned = cleaned.replace(/^[A-ZÀ-Ÿ]{2,}\s+/g, '');
      cleaned = cleaned.replace(/\s*\([A-ZÀ-Ÿ]{2,}\)\s*/g, ' ');
      cleaned = cleaned.replace(/\s*\[[A-ZÀ-Ÿ]{2,}\]\s*/g, ' ');
      cleaned = cleaned.replace(/\s+/g, ' ').trim();
      return cleaned;
    };
    const cleanPrenom = removeAbbreviations(prenom || '');
    const cleanNom = removeAbbreviations(nom || '');
    if (!cleanPrenom && !cleanNom) return t('orgNoName');
    if (!cleanPrenom) return formatEmployeeNom(cleanNom);
    if (!cleanNom) return formatEmployeePrenom(cleanPrenom);
    return `${formatEmployeePrenom(cleanPrenom)} ${formatEmployeeNom(cleanNom)}`.trim();
  };

  const cleanPosition = (poste) => {
    if (!poste) return t('orgNotSpecifiedPos');
    return poste.replace(/\s+[A-Z]{2,}$/g, '').replace(/[-–—][A-Z]{2,}$/g, '').trim();
  };

  const normalizeEmail = (email) => (email || '').trim().toLowerCase();

  const createVirtualRoot = (children = []) => ({
    id: 'organization-root',
    prenom: t('orgTitle'),
    nom: '',
    poste: t('orgActiveEmployees'),
    matricule: '',
    site_dep: 'Organization',
    adresse_mail: '',
    children,
    depth: 0,
    isCEO: true,
    isManager: true,
    isVirtual: true
  });

  const buildHierarchy = (sourceEmployees = employees) => {
    // Each node is keyed by the employee's own database id, never by email --
    // several accounts (e.g. shared "Gardien" records) reuse someone else's
    // address in adresse_mail, and keying by email would silently collapse
    // those distinct people into a single node, whichever loaded last winning.
    // ids are only unique per tenant schema, so the node id carries it too
    // (managers from another site/tenant can appear in the same chart).
    const allNodes = sourceEmployees.map((emp) => ({
      ...emp,
      id: `employee-${employeeKey(emp)}`,
      key: employeeKey(emp),
      employeeId: emp.id,
      email: normalizeEmail(emp.adresse_mail),
      prenom: emp.prenom?.trim() || '',
      nom: emp.nom?.trim() || '',
      poste: cleanPosition(translateStsJobTitle(emp.poste, emp)),
      children: [],
      depth: 0,
      isManager: false,
      parentId: null
    }));

    if (allNodes.length === 0) return createVirtualRoot();

    const nodesByEmail = new Map();
    allNodes.forEach((node) => {
      if (!node.email) return;
      if (!nodesByEmail.has(node.email)) nodesByEmail.set(node.email, []);
      nodesByEmail.get(node.email).push(node);
    });

    // When several employees share one email, pick whichever of them does
    // NOT list that same email as their own manager -- a record whose
    // manager email equals its own email is the data glitch, not the
    // person other employees actually report to.
    const resolveManagerNode = (email, excludeNode) => {
      const candidates = (nodesByEmail.get(email) || []).filter((n) => n !== excludeNode);
      if (candidates.length === 0) return null;
      const nonSelfReferential = candidates.find((n) => {
        const r1 = normalizeEmail(n.mail_responsable1);
        const r2 = normalizeEmail(n.mail_responsable2);
        return r1 !== n.email && r2 !== n.email;
      });
      return nonSelfReferential || candidates[0];
    };

    const nodesByKey = new Map(allNodes.map((node) => [node.key, node]));

    // Non-SAHEL: the chart is KPI's (GET /org-chart/links, built from the KPI
    // role tree) -- no HR email fallback, so outdated HR managers can't
    // reappear. SAHEL keeps its HR manager-email chart, which is correct.
    const findManager = (node) => {
      if (kpiParents.has(node.key)) {
        const kpiParent = kpiParents.get(node.key);
        return kpiParent && kpiParent !== node.key && nodesByKey.has(kpiParent) ? nodesByKey.get(kpiParent) : null;
      }
      const resp1 = normalizeEmail(node.mail_responsable1);
      const resp2 = normalizeEmail(node.mail_responsable2);
      return (resp1 ? resolveManagerNode(resp1, node) : null) ||
        (resp2 ? resolveManagerNode(resp2, node) : null);
    };

    const roots = [];
    allNodes.forEach((node) => {
      const manager = findManager(node);
      if (manager) {
        manager.isManager = true;
        manager.children.push(node);
        node.parentId = manager.id;
      } else {
        roots.push(node);
      }
    });

    if (roots.length === 0) {
      const fallbackRoot = allNodes.find((emp) => emp.isManager) || allNodes[0];
      if (fallbackRoot) roots.push(fallbackRoot);
    }

    const setDepth = (node, depth = 0, visited = new Set()) => {
      if (!node || visited.has(node.id)) return;
      visited.add(node.id);
      node.depth = depth;
      node.children = (node.children || []).filter((child) => child.id !== node.id && !visited.has(child.id));
      node.children.forEach((child) => setDepth(child, depth + 1, new Set(visited)));
    };

    const plantManagerRoot = roots.find((emp) =>
      emp.prenom?.toLowerCase().includes('jamie') &&
      emp.nom?.toLowerCase().includes('lambert')
    );
    const managerRoot = roots.find((emp) => emp.isManager) || roots[0];
    const rootNode = plantManagerRoot || managerRoot;

    if (roots.length === 1 && rootNode) {
      rootNode.isCEO = true;
      rootNode.isManager = true;
      setDepth(rootNode);
      return rootNode;
    }

    // Biggest tree first: the plant manager's, then whoever isn't connected.
    const treeSize = (node, seen = new Set()) => {
      if (seen.has(node.id)) return 0;
      seen.add(node.id);
      return 1 + node.children.reduce((sum, child) => sum + treeSize(child, seen), 0);
    };
    roots.sort((a, b) => treeSize(b) - treeSize(a));

    // The plant manager (Jamie for SAHEL) heads the chart, direct team spread
    // out as the next layer. People at the site whose manager is outside it
    // (KAM, Costing, ...) sit in that row too, attached with a dashed line;
    // the chart draws their outside manager above.
    const main = plantManagerRoot || roots[0];
    roots.filter((node) => node !== main).forEach((node) => {
      node.detached = true;
      main.children.push(node);
    });
    main.isCEO = true;
    main.isManager = true;
    setDepth(main);
    return main;
  };

  useEffect(() => { fetchEmployees(); }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      setGroupNodes(null);
      setGroupError(false);
      const response = await employeesAPI.getAll();
      let activeEmployees = response.data.filter((emp) => emp.statut === 'actif' || !emp.statut);
      {
        try {
          const { links = [], sts_links: stsLinks = [], external = [], additional = [] } = (await api.get('/org-chart/links')).data || {};
          const parents = new Map([...links, ...external].map((l) => [l.key, l.parent_key]));
          // Outside SAHEL the chart is KPI: someone KPI gives no active role
          // to (e.g. a former plant manager still active in HR) is left out.
          activeEmployees = activeEmployees.filter((emp) =>
            (emp.tenant_schema || 'public') === 'public' || parents.has(employeeKey(emp)));
          // A second role under the person's main one (the CEO's VP
          // Development): its own box, key "<tenant_schema>:a<assignment_id>".
          const byKey = new Map(activeEmployees.map((emp) => [employeeKey(emp), emp]));
          activeEmployees = activeEmployees.concat(additional.filter((a) => byKey.has(a.owner_key)).map((a) => ({
            ...byKey.get(a.owner_key),
            id: a.key.slice(a.key.indexOf(':') + 1),
            poste: a.role_name,
            isAdditional: true
          })));
          // Managers KPI knows but the viewer has no HR record of (another
          // company, a group role): drawn from KPI so the chain reaches the top.
          // key "kpi:<people_id>" = employeeKey of { tenant_schema: 'kpi', id }.
          activeEmployees = activeEmployees.concat(external.map((node) => ({
            ...node,
            id: node.key.slice('kpi:'.length),
            tenant_schema: 'kpi',
            statut: 'actif',
            isExternal: true
          })));
          setKpiParents(parents);
          setKpiBoss(new Map([...links, ...stsLinks, ...external].map((l) => [l.key, l.parent_key])));
        } catch (linkError) {
          console.error('KPI organigramme unavailable -- HR managers used instead', linkError);
        }
      }
      setEmployees(activeEmployees);
      setFilteredEmployees(activeEmployees);
    } catch (error) {
      console.error(t('errorLoadingEmployees'), error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let scopedEmployees = employees.filter((employee) => !employee.isExternal &&
      (!canFilterByPlant || !selectedPlant || getEmployeeSite(employee) === selectedPlant));
    // One chart per plant, headed by its plant manager (2026-10-27).
    // A site without its own plant manager is run from another site of the
    // company (e.g. Poitiers by Jules COSTA, recorded at Loire): climb
    // to that plant manager so they head the chart. Other managers outside
    // the site are drawn above the chart instead (see the render).
    // A climb that never reaches a plant manager (SAHEL: Jamie's chain goes
    // VP Finance -> CEO) adds nobody, so the site keeps its own head.
    const isPlantHead = (emp) => /plant\s*manager/i.test(emp.poste || '');
    if (!scopedEmployees.some(isPlantHead)) {
      const parentOf = makeParentResolver(employees, kpiParents);
      const included = new Set(scopedEmployees);
      for (const emp of scopedEmployees) {
        if (isPlantHead(emp)) continue;
        const path = [];
        let boss = parentOf(emp);
        for (let hop = 0; boss && hop < 20 && !included.has(boss) && !path.includes(boss); hop += 1) {
          if (!boss.isExternal && (boss.tenant_schema || 'public') !== (emp.tenant_schema || 'public')) break;
          path.push(boss);
          if (isPlantHead(boss)) break;
          boss = parentOf(boss);
        }
        if (path.some(isPlantHead) || (boss && included.has(boss))) path.forEach((p) => included.add(p));
      }
      scopedEmployees = [...included];
    }

    if (searchTerm.trim() === '') {
      setFilteredEmployees(scopedEmployees);
    } else {
      const q = searchTerm.toLowerCase();
      setFilteredEmployees(scopedEmployees.filter((emp) => {
        const fullName = cleanName(emp.prenom, emp.nom).toLowerCase();
        const position = cleanPosition(emp.poste).toLowerCase();
        return fullName.includes(q) || position.includes(q) || emp.site_dep?.toLowerCase().includes(q) || emp.matricule?.toLowerCase().includes(q);
      }));
    }
  }, [searchTerm, employees, selectedPlant, canFilterByPlant, kpiParents]);

  // Chart format (2026-10-28, from the "SAHEL Tunisia - Organization
  // Chart" PDF): flat navy boxes with the name and role, the head on top in
  // orange, the head's direct team in one row, each member's team stacked
  // below in columns on a rail, square connector lines. Dashed = attached to
  // the site but reporting outside it (detached).
  useEffect(() => {
    if (groupView || loading || !svgRef.current || filteredEmployees.length === 0) return;

    d3.select(svgRef.current).selectAll('*').remove();

    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
    const W = 170;          // box width
    const H = 62;           // box height
    const GAP_X = 18;       // between columns / level-1 blocks
    const GAP_Y = 12;       // between stacked boxes
    const RAIL = 12;        // rail offset left of a stacked team
    const LEVEL_GAP = 56;   // head -> level-1 row
    const MAX_ROWS = 12;    // shortest team column; big charts get taller ones
    const NAVY = '#0e4c7a';
    const ORANGE = '#ee7d11';
    const CYAN = '#22c3d6';
    const LINE = '#0e4c7a';

    const boxes = [];       // { x, y, data, head }
    const lines = [];       // { d, dashed }
    const hasTeam = (n) => (n.children || []).length > 0;

    // `kids` (no team of their own) in columns of at most maxRows (chosen
    // below to fit the screen), each on its own rail from barY, the first
    // rail at railX0 and the first box at `top`. Returns { w, h, lastRail },
    // w from railX0, h from top.
    const COL_W = W + RAIL + GAP_X;
    let maxRows = MAX_ROWS;
    const stackLeaves = (kids, railX0, barY, top) => {
      const cols = kids.length <= 8 ? 1 : Math.max(2, Math.ceil(kids.length / maxRows));
      const rows = Math.ceil(kids.length / cols);
      const railXs = Array.from({ length: cols }, (_, c) => railX0 + c * COL_W);
      railXs.forEach((railX, c) => {
        const colKids = kids.slice(c * rows, (c + 1) * rows);
        if (!colKids.length) return;
        colKids.forEach((kid, r) => {
          const ky = top + r * (H + GAP_Y);
          boxes.push({ x: railX + RAIL, y: ky, data: kid });
          lines.push({ d: `M ${railX},${ky + H / 2} L ${railX + RAIL},${ky + H / 2}`, dashed: !!kid.functional });
        });
        lines.push({ d: `M ${railX},${barY} L ${railX},${top + (colKids.length - 1) * (H + GAP_Y) + H / 2}` });
      });
      return { w: cols * (RAIL + W) + (cols - 1) * GAP_X, h: rows * (H + GAP_Y) - GAP_Y, lastRail: railXs[cols - 1] };
    };

    // Places `node`'s box at (x, y) (top-left) and its team below it; returns
    // the block's { w, h }.
    const place = (node, x, y) => {
      boxes.push({ x, y, data: node });
      const kids = node.children || [];
      if (!kids.length) return { w: W, h: H };
      const midX = x + W / 2;

      if (kids.every((k) => !hasTeam(k))) {
        // only leaves: one or more columns, each on its own rail
        const barY = y + H + GAP_Y / 2;
        const top = y + H + GAP_Y;
        lines.push({ d: `M ${midX},${y + H} L ${midX},${barY}` });
        const block = stackLeaves(kids, x + RAIL, barY, top);
        lines.push({ d: `M ${Math.min(x + RAIL, midX)},${barY} L ${Math.max(block.lastRail, midX)},${barY}` });
        return { w: Math.max(W, RAIL + block.w), h: H + GAP_Y + block.h };
      }

      // mixed: the members without a team in columns, then each member with
      // a team side by side, all hanging from one line -- wide rather than
      // one column as tall as the whole team
      const barY = y + H + GAP_Y;
      const top = barY + GAP_Y;
      lines.push({ d: `M ${midX},${y + H} L ${midX},${barY}` });
      const leaves = kids.filter((k) => !hasTeam(k));
      let cursor = x;
      let left = midX;
      let right = midX;
      let bottom = y + H;
      if (leaves.length) {
        const block = stackLeaves(leaves, x + RAIL, barY, top);
        left = Math.min(left, x + RAIL);
        right = Math.max(right, block.lastRail);
        cursor = x + RAIL + block.w + GAP_X * 2;
        bottom = Math.max(bottom, top + block.h);
      }
      kids.filter(hasTeam).forEach((kid) => {
        const size = place(kid, cursor, top);
        const kidMid = cursor + W / 2;
        lines.push({ d: `M ${kidMid},${barY} L ${kidMid},${top}`, dashed: !!kid.functional });
        left = Math.min(left, kidMid);
        right = Math.max(right, kidMid);
        cursor += size.w + GAP_X * 2;
        bottom = Math.max(bottom, top + size.h);
      });
      lines.push({ d: `M ${left},${barY} L ${right},${barY}` });
      return { w: Math.max(W, cursor - GAP_X * 2 - x), h: bottom - y };
    };

    // The head on top, its direct team in one row below.
    const head = buildHierarchy(filteredEmployees);
    const rowY = H + LEVEL_GAP;
    const busY = H + LEVEL_GAP / 2;

    // Closed teams are left out of the layout; their manager's box shows how
    // many people are below. A search shows every match, all open.
    const showAll = searchTerm.trim() !== '';
    const countTeam = (node) => {
      node.teamSize = (node.children || []).reduce((sum, kid) => sum + 1 + countTeam(kid), 0);
      return node.teamSize;
    };
    countTeam(head);
    const hideClosed = (node) => {
      if (node !== head && !showAll && !expandedKeys.has(node.key)) {
        node.collapsed = node.teamSize > 0;
        node.children = [];
        return;
      }
      (node.children || []).forEach(hideClosed);
    };
    hideClosed(head);
    const toggleTeam = (key) => {
      keepViewRef.current = true;
      setExpandedKeys((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    // Column height of the teams: the one whose chart is closest to the
    // screen's shape -- a big plant (ATLAS, 416 people under one production
    // manager) was one column tens of thousands of pixels tall (the developer,
    // 2026-11-02). A dry run of the head's row, then undone.
    const screenRatio = Math.min(3, Math.max(1.2, containerWidth / Math.max(containerHeight, 1)));
    let bestFit = null;
    for (let rows = MAX_ROWS; rows <= 80; rows += 2) {
      maxRows = rows;
      const [boxCount, lineCount] = [boxes.length, lines.length];
      let rowWidth = 0;
      let rowHeight = 0;
      (head.children || []).forEach((kid) => {
        const size = place(kid, 0, rowY);
        rowWidth += size.w + GAP_X * 2;
        rowHeight = Math.max(rowHeight, size.h);
      });
      boxes.length = boxCount;
      lines.length = lineCount;
      const miss = Math.abs(Math.log(Math.max(rowWidth, W) / (rowY + rowHeight) / screenRatio));
      if (!bestFit || miss < bestFit.miss - 0.01) bestFit = { miss, rows };
    }
    maxRows = bestFit.rows;

    // Above the chart (as in the SAHEL PDF): the head's managers up to the CEO,
    // and anyone's KPI manager who isn't in the chart (another site, the
    // group) -- linked to their people with an orange dashed line.
    const byKey = new Map(employees.map((emp) => [employeeKey(emp), emp]));
    const hrParentOf = makeParentResolver(employees, kpiParents);
    const bossOf = (emp) => (kpiBoss.has(employeeKey(emp)) ? byKey.get(kpiBoss.get(employeeKey(emp))) : null) || hrParentOf(emp);
    const treeNodes = [];
    const collect = (n) => { treeNodes.push(n); (n.children || []).forEach(collect); };
    collect(head);
    const inTree = new Set(treeNodes.map((n) => n.key));
    const chain = [];
    for (let boss = head.isVirtual ? null : bossOf(byKey.get(head.key) || {});
      boss && chain.length < 8 && !inTree.has(employeeKey(boss)) && !chain.includes(boss);
      boss = bossOf(boss)) {
      chain.push(boss);
    }
    const chainKeys = chain.map((emp) => employeeKey(emp));
    treeNodes.forEach((n) => {
      if (n === head) return;
      const own = byKey.get(n.key);
      const boss = own ? bossOf(own) : null;
      if (boss && !inTree.has(employeeKey(boss))) n.functional = boss;
    });
    // row order as in the PDF: reporting to the CEO/VP left, the plant's own
    // team in the middle, reporting to another outside manager right
    const rowGroup = (n) => {
      if (n.functional && chainKeys.includes(employeeKey(n.functional))) return 0;
      return n.detached || n.functional ? 2 : 1;
    };
    const functionalKey = (n) => (n.functional ? employeeKey(n.functional) : '');
    const level1 = [...(head.children || [])].sort((a, b) =>
      rowGroup(a) - rowGroup(b) || functionalKey(a).localeCompare(functionalKey(b)));
    // Row slots: people without a team who report to the same outside
    // manager are stacked in one column under that manager (one orange rail
    // instead of a line each); everyone else gets their own slot.
    const slots = [];
    level1.forEach((kid) => {
      const last = slots[slots.length - 1];
      const stackable = !!kid.functional && !hasTeam(kid);
      if (stackable && last && last.stack && last.key === functionalKey(kid)) last.members.push(kid);
      else slots.push({ key: functionalKey(kid), stack: stackable, members: [kid] });
    });
    const stacks = new Map(); // outside manager key -> { railX, boxes }
    let cursorX = 0;
    let bottom = H;
    const centers = slots.map((slot) => {
      if (slot.members.length === 1) {
        const kid = slot.members[0];
        const size = place(kid, cursorX, rowY);
        const center = cursorX + W / 2;
        cursorX += size.w + GAP_X * 2;
        bottom = Math.max(bottom, rowY + size.h);
        return { center, dashed: !!kid.detached || !!kid.functional };
      }
      const railX = cursorX;
      const boxX = cursorX + RAIL;
      const stackBoxes = slot.members.map((kid, r) => {
        const box = { x: boxX, y: rowY + r * (H + GAP_Y), data: kid };
        boxes.push(box);
        return box;
      });
      stacks.set(slot.key, { railX, boxes: stackBoxes });
      cursorX += RAIL + W + GAP_X * 2;
      bottom = Math.max(bottom, stackBoxes[stackBoxes.length - 1].y + H);
      return { center: boxX + W / 2, dashed: true };
    });
    const headX = centers.length
      ? (centers[0].center + centers[centers.length - 1].center) / 2 - W / 2
      : 0;
    boxes.push({ x: headX, y: 0, data: head, head: true });
    if (centers.length) {
      const headMid = headX + W / 2;
      const solid = centers.filter((c) => !c.dashed).map((c) => c.center);
      lines.push({ d: `M ${centers[0].center},${busY} L ${centers[centers.length - 1].center},${busY}`, dashed: true });
      lines.push({ d: `M ${Math.min(headMid, ...solid)},${busY} L ${Math.max(headMid, ...solid)},${busY}` });
      lines.push({ d: `M ${headMid},${H} L ${headMid},${busY}` });
      centers.forEach((c) => lines.push({ d: `M ${c.center},${busY} L ${c.center},${rowY}`, dashed: c.dashed }));
    }

    // the head's chain, stacked above them (the top one = CEO)
    const CHAIN_GAP = 26;
    const chainBox = new Map();
    chain.forEach((emp, i) => {
      const box = {
        x: headX,
        y: -(i + 1) * (H + CHAIN_GAP),
        data: { ...emp, poste: cleanPosition(emp.poste) },
        kind: i === chain.length - 1 ? 'top' : 'chain'
      };
      boxes.push(box);
      chainBox.set(employeeKey(emp), box);
      lines.push({ d: `M ${headX + W / 2},${box.y + H} L ${headX + W / 2},${box.y + H + CHAIN_GAP}` });
    });

    // outside managers: orange-outlined boxes at the head's level, above
    // their people; linked with orange dashed lines entering beside the box
    const boxOf = new Map(boxes.map((b) => [b.data, b]));
    const groups = new Map();
    treeNodes.forEach((n) => {
      if (!n.functional || !boxOf.has(n)) return;
      const key = employeeKey(n.functional);
      if (!groups.has(key)) groups.set(key, { manager: n.functional, people: [] });
      groups.get(key).people.push(boxOf.get(n));
    });
    const outsideBoxes = [...groups.entries()]
      .filter(([key]) => !chainBox.has(key))
      .map(([key, group]) => {
        const center = group.people.reduce((sum, p) => sum + p.x + W / 2, 0) / group.people.length;
        return { key, x: center - W / 2, y: 0, data: { ...group.manager, poste: cleanPosition(group.manager.poste) }, kind: 'outside' };
      })
      .sort((a, b) => a.x - b.x);
    // keep clear of the head (and its chain) and of each other
    let lastRight = -Infinity;
    outsideBoxes.forEach((box) => {
      if (box.x < headX + W + GAP_X && box.x + W > headX - GAP_X) {
        box.x = box.x + W / 2 < headX + W / 2 ? headX - GAP_X - W : headX + W + GAP_X;
      }
      box.x = Math.max(box.x, lastRight + GAP_X);
      if (box.x < headX + W + GAP_X && box.x + W > headX - GAP_X) box.x = headX + W + GAP_X;
      lastRight = box.x + W;
      boxes.push(box);
      chainBox.set(box.key, box);
    });
    let lane = 0;
    // from an outside / chain box over to x = laneX
    const routeStart = (from, laneX) => {
      if (from.kind === 'outside') {
        const turnY = from.y + H + 8 + (lane % 4) * 4;
        return `M ${from.x + W / 2},${from.y + H} L ${from.x + W / 2},${turnY} L ${laneX},${turnY}`;
      }
      // from the side of a chain box (CEO, VP)
      const sideX = laneX < from.x + W / 2 ? from.x : from.x + W;
      const y = from.y + H / 2 + (lane % 4) * 4 - 6;
      return `M ${sideX},${y} L ${laneX},${y}`;
    };
    groups.forEach((group, key) => {
      const from = chainBox.get(key);
      if (!from) return;
      const stack = stacks.get(key);
      if (stack) {
        // one rail down the stacked column, a tick into each box
        const lastMid = stack.boxes[stack.boxes.length - 1].y + H / 2;
        lines.push({ d: `${routeStart(from, stack.railX)} L ${stack.railX},${lastMid}`, functional: true });
        stack.boxes.forEach((b) => lines.push({ d: `M ${stack.railX},${b.y + H / 2} L ${b.x},${b.y + H / 2}`, functional: true }));
        lane += 1;
      }
      const stacked = new Set(stack ? stack.boxes : []);
      group.people.filter((p) => !stacked.has(p)).forEach((p) => {
        const leftSide = p.x + W / 2 < headX + W / 2;
        const laneX = leftSide ? p.x - 6 : p.x + W + 6;
        const entryX = leftSide ? p.x : p.x + W;
        const pMid = p.y + H / 2;
        lines.push({ d: `${routeStart(from, laneX)} L ${laneX},${pMid} L ${entryX},${pMid}`, functional: true });
        lane += 1;
      });
    });

    const minX = Math.min(0, headX, ...outsideBoxes.map((b) => b.x));
    const maxX = Math.max(cursorX - GAP_X * 2, headX + W, ...outsideBoxes.map((b) => b.x + W));
    const topY = chain.length ? -chain.length * (H + CHAIN_GAP) : 0;

    const svg = d3.select(svgRef.current).attr('width', containerWidth).attr('height', containerHeight);
    const g = svg.append('g').attr('class', 'main-group').style('font-family', 'Arial, Helvetica, sans-serif');

    // Title block (also in the PDF export / print)
    const siteName = String(selectedPlant || getEmployeeSite(head) || '').replace(/^Site-/i, '');
    const titleY = topY - 50;
    // at least as wide as logo + title + date, so a small site doesn't overlap them
    const headerWidth = Math.max(maxX - minX, 1200);
    const headerLeft = (minX + maxX) / 2 - headerWidth / 2;
    const headerRight = headerLeft + headerWidth;
    if (logoData) {
      g.append('image').attr('href', logoData).attr('x', headerLeft).attr('y', titleY - 30)
        .attr('width', 170).attr('height', 46).attr('preserveAspectRatio', 'xMinYMid meet');
    }
    g.append('text').attr('x', (minX + maxX) / 2).attr('y', titleY).attr('text-anchor', 'middle')
      .attr('fill', NAVY).style('font-size', '26px').style('font-weight', '700')
      .text(siteName ? `${siteName} – ${t('orgTitle')}` : t('orgTitle'));
    g.append('text').attr('x', headerRight).attr('y', titleY).attr('text-anchor', 'end')
      .attr('fill', '#111827').style('font-size', '13px').style('font-weight', '700')
      .text(`${t('orgUpdate')} : ${new Date().toLocaleDateString('fr-FR')}`);

    g.selectAll('.link').data(lines).enter().append('path')
      .attr('class', 'link')
      .attr('d', (l) => l.d)
      .attr('fill', 'none')
      .attr('stroke', (l) => (l.functional ? ORANGE : LINE))
      .attr('stroke-width', (l) => (l.functional ? 1.8 : 1.4))
      .attr('stroke-dasharray', (l) => (l.dashed || l.functional ? '5 4' : null));

    // Text wrapped on whole words into at most `maxLines` lines.
    const wrap = (text, maxChars, maxLines) => {
      const out = [];
      let current = '';
      String(text || '').split(/\s+/).filter(Boolean).forEach((word) => {
        if (!current) current = word;
        else if (`${current} ${word}`.length <= maxChars) current = `${current} ${word}`;
        else { out.push(current); current = word; }
      });
      if (current) out.push(current);
      if (out.length > maxLines) {
        const kept = out.slice(0, maxLines);
        kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, maxChars - 1)}…`;
        return kept;
      }
      return out;
    };

    const node = g.selectAll('.node').data(boxes).enter().append('g')
      .attr('class', 'node')
      .attr('transform', (b) => `translate(${b.x},${b.y})`)
      .style('cursor', 'pointer')
      .on('click', (event, b) => { event.stopPropagation(); if (!b.data.isVirtual) setSelectedNode(b.data); })
      .on('mouseover', function () {
        d3.select(this).select('.node-container').attr('stroke', '#fbbf24').attr('stroke-width', 3);
      })
      .on('mouseout', function (event, b) {
        d3.select(this).select('.node-container')
          .attr('stroke', b.kind === 'outside' ? ORANGE : null)
          .attr('stroke-width', b.kind === 'outside' ? 2.5 : null);
      });

    node.append('rect').attr('class', 'node-container')
      .attr('width', W).attr('height', H)
      .attr('fill', (b) => {
        if (b.kind === 'top') return CYAN;
        if (b.kind === 'outside') return 'white';
        return b.head || b.kind === 'chain' ? ORANGE : NAVY;
      })
      .attr('stroke', (b) => (b.kind === 'outside' ? ORANGE : null))
      .attr('stroke-width', (b) => (b.kind === 'outside' ? 2.5 : null));

    node.each(function (b) {
      const name = wrap(cleanName(b.data.prenom, b.data.nom), 22, 2);
      const role = wrap(b.data.poste, 26, b.data.isAdditional ? 1 : 2);
      const total = name.length * 14 + role.length * 12 + (b.data.isAdditional ? 11 : 0);
      let y = (H - total) / 2 + 11;
      const el = d3.select(this);
      name.forEach((line) => {
        el.append('text').attr('x', W / 2).attr('y', y).attr('text-anchor', 'middle')
          .attr('fill', b.kind === 'outside' ? NAVY : 'white').style('font-size', '12px').style('font-weight', '700').text(line);
        y += 14;
      });
      role.forEach((line) => {
        el.append('text').attr('x', W / 2).attr('y', y).attr('text-anchor', 'middle')
          .attr('fill', b.kind === 'outside' ? '#475569' : 'rgba(255,255,255,0.88)').style('font-size', '10px').text(line);
        y += 12;
      });
      if (b.data.isAdditional) {
        el.append('text').attr('x', W / 2).attr('y', y).attr('text-anchor', 'middle')
          .attr('fill', 'rgba(255,255,255,0.88)').style('font-size', '8px').text(t('orgAdditionalAssignment'));
      }
      // "+ 12" / "− 12" on the box's bottom edge opens / closes the team
      if (b.data.teamSize && !b.head && !b.kind && !showAll) {
        const toggle = el.append('g').attr('class', 'node-toggle')
          .attr('transform', `translate(${W / 2 - 26},${H - 6})`)
          .on('click', (event) => { event.stopPropagation(); toggleTeam(b.data.key); });
        toggle.append('title').text(b.data.collapsed ? t('orgShowTeam') : t('orgHideTeam'));
        toggle.append('rect').attr('width', 52).attr('height', 16).attr('rx', 8)
          .attr('fill', 'white').attr('stroke', ORANGE).attr('stroke-width', 1.5);
        toggle.append('text').attr('x', 26).attr('y', 12).attr('text-anchor', 'middle')
          .attr('fill', NAVY).style('font-size', '10px').style('font-weight', '700')
          .text(`${b.data.collapsed ? '+' : '−'} ${b.data.teamSize}`);
      }
    });

    // Legend under the chart
    const legendY = bottom + 50;
    const legend = g.append('g').attr('transform', `translate(${(minX + maxX) / 2 - 660},${legendY})`);
    [
      { label: t('orgLegendDirect'), color: LINE },
      { label: t('orgLegendAttached'), color: LINE, dashed: true },
      { label: t('orgLegendFunctional'), color: ORANGE, dashed: true },
      { label: t('orgLegendOutsideManager'), box: true }
    ].forEach((item, i) => {
      const lg = legend.append('g').attr('transform', `translate(${i * 340},0)`);
      if (item.box) {
        lg.append('rect').attr('x', 0).attr('y', -10).attr('width', 50).attr('height', 20)
          .attr('fill', 'white').attr('stroke', ORANGE).attr('stroke-width', 2.5);
      } else {
        lg.append('path').attr('d', 'M 0,0 L 50,0').attr('stroke', item.color).attr('stroke-width', 2)
          .attr('stroke-dasharray', item.dashed ? '5 4' : null);
      }
      lg.append('text').attr('x', 62).attr('y', 4).attr('fill', NAVY).style('font-size', '13px').text(item.label);
    });

    const zoom = d3.zoom().scaleExtent([0.05, 3]).on('zoom', (event) => {
      g.attr('transform', event.transform);
      viewRef.current = event.transform;
      setZoomLevel(event.transform.k);
    });
    zoomRef.current = zoom;
    svg.call(zoom);

    // Fit the chart's width (not below 25% -- big plants are then panned)
    const chartWidth = Math.max(maxX - minX, 1360) + 80;
    const scale = Math.max(0.25, Math.min(1, containerWidth / chartWidth));
    const fitX = scale * chartWidth < containerWidth
      ? containerWidth / 2 - ((minX + maxX) / 2) * scale
      : containerWidth / 2 - (headX + W / 2) * scale;
    fitTransformRef.current = d3.zoomIdentity.translate(fitX, (90 - titleY) * scale + 10).scale(scale);
    // a team just opened / closed: stay where the user is
    svg.call(zoom.transform, keepViewRef.current && viewRef.current ? viewRef.current : fitTransformRef.current);
    keepViewRef.current = false;
  }, [filteredEmployees, loading, logoData, selectedPlant, employees, kpiParents, kpiBoss, groupView, expandedKeys, searchTerm]);

  // Group chart, in the "Northwind Group" PDF's format: the CEO on top in
  // orange, VPs (G7) in blue, Directors (G6) in navy; each manager's team in
  // a row below, people without a team of their own stacked on a rail.
  // Dashed = reports through a level below G6.
  useEffect(() => {
    if (!groupView || loading || !svgRef.current) return;
    d3.select(svgRef.current).selectAll('*').remove();
    if (!groupNodes || groupNodes.length === 0) return;

    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
    const W = 170;
    const H = 74;
    const GAP_X = 18;
    const GAP_Y = 12;
    const RAIL = 12;
    const LEVEL_GAP = 48;
    const MAX_ROWS = 12;
    const NAVY = '#0e4c7a';
    const ORANGE = '#ee7d11';
    const VP_BLUE = '#1f73b7';
    const GRADE_RANK = { G7: 0, G6: 1 };

    const nodes = groupNodes.map((n) => ({ ...n, site_dep: n.site, children: [] }));
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    const roots = [];
    nodes.forEach((n) => {
      const parent = n.parent_key && byKey.get(n.parent_key);
      if (parent) parent.children.push(n);
      else roots.push(n);
    });
    const sortTeam = (n) => {
      n.children.sort((a, b) => GRADE_RANK[a.grade] - GRADE_RANK[b.grade] ||
        String(a.poste).localeCompare(String(b.poste)) || String(a.site || '').localeCompare(String(b.site || '')));
      n.children.forEach(sortTeam);
    };
    const top = roots.find((r) => r.grade === 'G7') || roots[0];
    roots.filter((r) => r !== top).forEach((r) => { r.indirect = true; top.children.push(r); });
    sortTeam(top);

    const boxes = [];
    const lines = [];
    const hasTeam = (n) => n.children.length > 0;

    // `kids` (no team of their own) stacked on rails starting at (x, fromY),
    // first box at boxTop; returns the block's { w, h } from boxTop.
    const stack = (kids, x, fromY, boxTop) => {
      const cols = Math.ceil(kids.length / MAX_ROWS);
      const rows = Math.ceil(kids.length / cols);
      for (let c = 0; c < cols; c += 1) {
        const railX = x + c * (RAIL + W + GAP_X);
        const colKids = kids.slice(c * rows, (c + 1) * rows);
        colKids.forEach((kid, r) => {
          const ky = boxTop + r * (H + GAP_Y);
          boxes.push({ x: railX + RAIL, y: ky, data: kid });
          lines.push({ d: `M ${railX},${ky + H / 2} L ${railX + RAIL},${ky + H / 2}`, dashed: !!kid.indirect });
        });
        lines.push({ d: `M ${railX},${fromY} L ${railX},${boxTop + (colKids.length - 1) * (H + GAP_Y) + H / 2}` });
      }
      if (cols > 1) lines.push({ d: `M ${x},${fromY} L ${x + (cols - 1) * (RAIL + W + GAP_X)},${fromY}` });
      return { w: cols * (RAIL + W) + (cols - 1) * GAP_X, h: rows * (H + GAP_Y) - GAP_Y };
    };

    // Places `node` with its team, the block's left edge at x; returns
    // { w, h, center } (center = the middle of the node's own box).
    const place = (node, x, y) => {
      const kids = node.children;
      if (!kids.length) {
        boxes.push({ x, y, data: node });
        return { w: W, h: H, center: x + W / 2 };
      }
      // A single stack under the box only when everyone is the same grade:
      // a G7 box on top of G6 boxes would read as their manager.
      const leaves = kids.filter((k) => !hasTeam(k));
      const leafGrades = [...new Set(leaves.map((k) => k.grade))]
        .sort((a, b) => GRADE_RANK[a] - GRADE_RANK[b]);
      if (leaves.length === kids.length && leafGrades.length === 1) {
        boxes.push({ x, y, data: node });
        const size = stack(kids, x + RAIL, y + H, y + H + GAP_Y);
        return { w: Math.max(W, RAIL + size.w), h: H + GAP_Y + size.h, center: x + W / 2 };
      }
      // members without a team stacked one column per grade, then every
      // member with a team side by side, all hanging from one line
      const barY = y + H + LEVEL_GAP / 2;
      const rowY = y + H + LEVEL_GAP;
      const drops = [];
      let cursor = x;
      let bottom = y + H;
      leafGrades.forEach((grade) => {
        const size = stack(leaves.filter((k) => k.grade === grade), cursor, barY, rowY);
        drops.push({ center: cursor, rail: true });
        cursor += size.w + GAP_X * 2;
        bottom = Math.max(bottom, rowY + size.h);
      });
      kids.filter(hasTeam).forEach((kid) => {
        const size = place(kid, cursor, rowY);
        drops.push({ center: size.center, dashed: !!kid.indirect });
        cursor += size.w + GAP_X * 2;
        bottom = Math.max(bottom, rowY + size.h);
      });
      const first = drops[0].center;
      const last = drops[drops.length - 1].center;
      const boxX = Math.max(x, (first + last) / 2 - W / 2);
      const mid = boxX + W / 2;
      boxes.push({ x: boxX, y, data: node });
      lines.push({ d: `M ${mid},${y + H} L ${mid},${barY}` });
      lines.push({ d: `M ${Math.min(first, mid)},${barY} L ${Math.max(last, mid)},${barY}` });
      drops.filter((d) => !d.rail).forEach((d) => lines.push({ d: `M ${d.center},${barY} L ${d.center},${rowY}`, dashed: d.dashed }));
      return { w: Math.max(cursor - GAP_X * 2 - x, boxX + W - x), h: bottom - y, center: mid };
    };

    const size = place(top, 0, 0);
    const minX = 0;
    const maxX = size.w;
    const bottom = size.h;

    const svg = d3.select(svgRef.current).attr('width', containerWidth).attr('height', containerHeight);
    const g = svg.append('g').attr('class', 'main-group').style('font-family', 'Arial, Helvetica, sans-serif');

    const titleY = -50;
    const headerWidth = Math.max(maxX - minX, 1200);
    const headerLeft = (minX + maxX) / 2 - headerWidth / 2;
    if (logoData) {
      g.append('image').attr('href', logoData).attr('x', headerLeft).attr('y', titleY - 30)
        .attr('width', 170).attr('height', 46).attr('preserveAspectRatio', 'xMinYMid meet');
    }
    g.append('text').attr('x', (minX + maxX) / 2).attr('y', titleY).attr('text-anchor', 'middle')
      .attr('fill', NAVY).style('font-size', '26px').style('font-weight', '700')
      .text(`Northwind Group – ${t('orgTitle')}`);
    g.append('text').attr('x', headerLeft + headerWidth).attr('y', titleY).attr('text-anchor', 'end')
      .attr('fill', '#111827').style('font-size', '13px').style('font-weight', '700')
      .text(`${t('orgUpdate')} : ${new Date().toLocaleDateString('fr-FR')}`);

    g.selectAll('.link').data(lines).enter().append('path')
      .attr('class', 'link')
      .attr('d', (l) => l.d)
      .attr('fill', 'none')
      .attr('stroke', NAVY)
      .attr('stroke-width', 1.4)
      .attr('stroke-dasharray', (l) => (l.dashed ? '5 4' : null));

    const fill = (b) => {
      if (b.data === top) return ORANGE;
      return b.data.grade === 'G7' ? VP_BLUE : NAVY;
    };
    const node = g.selectAll('.node').data(boxes).enter().append('g')
      .attr('class', 'node')
      .attr('transform', (b) => `translate(${b.x},${b.y})`)
      .style('cursor', 'pointer')
      .on('click', (event, b) => { event.stopPropagation(); setSelectedNode(b.data); })
      .on('mouseover', function () {
        d3.select(this).select('.node-container').attr('stroke', '#fbbf24').attr('stroke-width', 3);
      })
      .on('mouseout', function () {
        d3.select(this).select('.node-container').attr('stroke', null).attr('stroke-width', null);
      });
    node.append('rect').attr('class', 'node-container')
      .attr('width', W).attr('height', H)
      .attr('fill', fill);
    node.each(function (b) {
      const el = d3.select(this);
      const textColor = 'white';
      const subColor = 'rgba(255,255,255,0.88)';
      el.append('text').attr('x', W - 5).attr('y', 11).attr('text-anchor', 'end')
        .attr('fill', subColor).style('font-size', '9px').style('font-weight', '700').text(b.data.grade);
      // Everything stays inside the box: below the grade tag, the site line
      // then a second role line dropped when short of room, and any line
      // still wider than the box squeezed to fit.
      const TEXT_TOP = 14;
      const room = H - TEXT_TOP - 4;
      const name = wrapText([b.data.prenom, b.data.nom].filter(Boolean).join(' '), 20, 2);
      let role = wrapText(b.data.poste, 28, 2);
      let site = b.data.site && !/group/i.test(b.data.site) ? wrapText(b.data.site, 28, 1) : [];
      const height = () => name.length * 14 + (role.length + site.length) * 12;
      if (height() > room) site = [];
      if (height() > room) role = wrapText(b.data.poste, 28, 1);
      let y = TEXT_TOP + (room - height()) / 2 + 10;
      const fit = (text) => {
        if (text.node().getComputedTextLength() > W - 10) {
          text.attr('textLength', W - 10).attr('lengthAdjust', 'spacingAndGlyphs');
        }
      };
      name.forEach((line) => {
        fit(el.append('text').attr('x', W / 2).attr('y', y).attr('text-anchor', 'middle')
          .attr('fill', textColor).style('font-size', '12px').style('font-weight', '700').text(line));
        y += 14;
      });
      [...role, ...site].forEach((line) => {
        fit(el.append('text').attr('x', W / 2).attr('y', y).attr('text-anchor', 'middle')
          .attr('fill', subColor).style('font-size', '10px').text(line));
        y += 12;
      });
    });

    // Legend: the two levels (KPI's own labels) and the dashed line
    const levelLabel = (grade) => {
      const level = groupNodes.find((n) => n.grade === grade)?.level;
      return level ? `${grade} – ${level}` : grade;
    };
    const legend = g.append('g').attr('transform', `translate(${(minX + maxX) / 2 - 390},${bottom + 50})`);
    [
      { label: levelLabel('G7'), color: VP_BLUE },
      { label: levelLabel('G6'), color: NAVY },
      { label: t('orgGroupIndirect'), dashed: true }
    ].forEach((item, i) => {
      const lg = legend.append('g').attr('transform', `translate(${i * 260},0)`);
      if (item.dashed) {
        lg.append('path').attr('d', 'M 0,0 L 50,0').attr('stroke', NAVY).attr('stroke-width', 2).attr('stroke-dasharray', '5 4');
      } else {
        lg.append('rect').attr('x', 0).attr('y', -10).attr('width', 50).attr('height', 20)
          .attr('fill', item.color);
      }
      lg.append('text').attr('x', 62).attr('y', 4).attr('fill', NAVY).style('font-size', '13px').text(item.label);
    });

    const zoom = d3.zoom().scaleExtent([0.05, 3]).on('zoom', (event) => {
      g.attr('transform', event.transform);
      setZoomLevel(event.transform.k);
    });
    zoomRef.current = zoom;
    svg.call(zoom);
    // the whole group in view
    const chartWidth = Math.max(maxX - minX, 1200) + 80;
    const scale = Math.max(0.1, Math.min(1, containerWidth / chartWidth));
    fitTransformRef.current = d3.zoomIdentity
      .translate(containerWidth / 2 - ((minX + maxX) / 2) * scale, (90 - titleY) * scale + 10)
      .scale(scale);
    svg.call(zoom.transform, fitTransformRef.current);
  }, [groupView, groupNodes, loading, logoData]);

  const buildFullSVGString = () => {
    const svg = svgRef.current;
    if (!svg) return null;
    const mainGroup = svg.querySelector('.main-group');
    if (!mainGroup) return null;
    const bbox = mainGroup.getBBox();
    const padding = 60;
    const fullWidth = Math.ceil(bbox.width + padding * 2);
    const fullHeight = Math.ceil(bbox.height + padding * 2);
    const cloned = svg.cloneNode(true);
    cloned.setAttribute('width', fullWidth);
    cloned.setAttribute('height', fullHeight);
    cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const clonedGroup = cloned.querySelector('.main-group');
    if (clonedGroup) {
      clonedGroup.setAttribute('transform', `translate(${-bbox.x + padding}, ${-bbox.y + padding})`);
    }
    cloned.setAttribute('style', 'background:#ffffff; font-family: Arial, sans-serif;');
    const serializer = new XMLSerializer();
    return { svgString: serializer.serializeToString(cloned), fullWidth, fullHeight };
  };

  const svgStringToCanvas = ({ svgString, fullWidth, fullHeight }) => {
    return new Promise((resolve, reject) => {
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        // 2x for sharpness, but a big plant (ATLAS: tens of thousands of px
        // wide) must stay within what a browser canvas can hold -- past that
        // the tab freezes or the canvas comes out blank.
        const MAX_SIDE = 16000;
        const MAX_AREA = 60e6;
        const scale = Math.min(2, MAX_SIDE / fullWidth, MAX_SIDE / fullHeight,
          Math.sqrt(MAX_AREA / (fullWidth * fullHeight)));
        canvas.width = fullWidth * scale;
        canvas.height = fullHeight * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, fullWidth, fullHeight);
        ctx.drawImage(img, 0, 0, fullWidth, fullHeight);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(t('orgSvgLoadError')));
      };
      img.src = url;
    });
  };

  const exportToPDF = async () => {
    if (!svgRef.current || exporting) return;
    setExporting(true);
    try {
      const svgData = buildFullSVGString();
      if (!svgData) throw new Error(t('orgSvgNotFound'));
      const canvas = await svgStringToCanvas(svgData);
      const imgData = canvas.toDataURL('image/png');
      const { default: jsPDF } = await import('jspdf');
      // a PDF page is at most 14400 pt a side: shrink the page, not the image
      const pageScale = Math.min(1, 14400 / canvas.width, 14400 / canvas.height);
      const pageWidth = canvas.width * pageScale;
      const pageHeight = canvas.height * pageScale;
      const pdf = new jsPDF({
        orientation: pageWidth >= pageHeight ? 'landscape' : 'portrait',
        unit: 'pt',
        format: [pageWidth, pageHeight]
      });
      pdf.addImage(imgData, 'PNG', 0, 0, pageWidth, pageHeight);
      // e.g. "Atlas - Organization Chart_2026-10-28.pdf"
      const plantName = groupView ? 'Northwind Group' : String(selectedPlant ||
        getEmployeeSite(filteredEmployees.find((emp) => !emp.isExternal) || {}) || '').replace(/^Site-/i, '');
      const fileTitle = plantName ? `${plantName} - ${t('orgTitle')}` : t('orgTitle');
      pdf.save(`${fileTitle}_${new Date().toISOString().split('T')[0]}.pdf`);
    } catch (err) {
      console.error(t('orgExportError'), err);
      alert(t('orgExportError') + err.message);
    } finally {
      setExporting(false);
    }
  };

  const printOrganigramme = async () => {
    if (!svgRef.current || exporting) return;
    setExporting(true);
    setSelectedNode(null);
    try {
      const svgData = buildFullSVGString();
      if (!svgData) throw new Error(t('orgSvgNotFound'));
      const canvas = await svgStringToCanvas(svgData);
      const imgData = canvas.toDataURL('image/png');
      const aspectRatio = canvas.width / canvas.height;
      const printWindow = window.open('', '_blank');
      if (!printWindow) {
        alert(t('orgPopupBlocked'));
        return;
      }
      printWindow.document.open();
      printWindow.document.write(`
        <!doctype html>
        <html lang="fr">
          <head>
            <meta charset="utf-8" />
            <title>${t('orgTitle')}</title>
            <style>
              @page { size: landscape; margin: 8mm; }
              html, body { margin: 0; padding: 0; background: #fff; width: 100%; height: 100%; }
              .page { width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
              img { max-width: 100%; max-height: 100%; width: auto; height: auto; aspect-ratio: ${aspectRatio}; object-fit: contain; display: block; }
            </style>
          </head>
          <body>
            <div class="page"><img src="${imgData}" alt="${t('orgTitle')}" /></div>
            <script>
              window.onload = function () {
                setTimeout(function () { window.focus(); window.print(); window.onafterprint = function () { window.close(); }; }, 600);
              };
            <\/script>
          </body>
        </html>
      `);
      printWindow.document.close();
    } catch (err) {
      console.error(t('orgPrintError'), err);
      alert(t('orgPrintError') + err.message);
    } finally {
      setExporting(false);
    }
  };

  const groupSites = new Set((groupNodes || []).map((n) => n.site).filter(Boolean));
  const groupManagers = new Set((groupNodes || []).map((n) => n.parent_key).filter(Boolean));
  const stats = groupView ? {
    total: (groupNodes || []).length,
    departments: groupSites.size,
    managers: groupManagers.size
  } : {
    // a second role's box is not another employee
    total: filteredEmployees.filter((e) => !e.isAdditional).length,
    departments: [...new Set(filteredEmployees.map((e) => e.site_dep).filter(Boolean))].length,
    managers: filteredEmployees.filter((e) => !e.isAdditional).filter((e) => {
      const email = e.adresse_mail?.toLowerCase();
      return filteredEmployees.some((emp) => emp.mail_responsable1?.toLowerCase() === email);
    }).length
  };
  const previewRoot = !groupView && filteredEmployees.length > 0 ? buildHierarchy(filteredEmployees) : null;
  const rootBadgeText = groupView
    ? t('orgGroupChart')
    : previewRoot && !previewRoot.isVirtual
    ? `${previewRoot.poste || t('orgNotSpecifiedPos')} : ${cleanName(previewRoot.prenom, previewRoot.nom)}`
    : t('orgTitle');

  if (loading) {
    return (
      <div className="organigramme-page-container">
        <Sidebar />
        <div className="organigramme-container">
          <div className="loading">
            <div className="spinner"></div>
            <p>{t('orgLoading')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="organigramme-page-container">
      <Sidebar />
      <div className="organigramme-container">

        <div className="organigramme-header">
          <h1>{t('orgTitle')}</h1>
          <p className="subtitle">
            <span className="ceo-badge">{rootBadgeText}</span>
            <span className="disposition-badge-horizontal">{t('orgLevel1Badge')}</span>
            <span className="disposition-badge-vertical">{t('orgTeamsBadge')}</span>
          </p>
        </div>

        <div className="organigramme-stats">
          <div className="stat-card">
            <div className="stat-icon"><User size={24} /></div>
            <div className="stat-info"><h3>{stats.total}</h3><p>{t('orgActiveEmployees')}</p></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon"><Briefcase size={24} /></div>
            <div className="stat-info"><h3>{stats.departments}</h3><p>{t('orgDepartments')}</p></div>
          </div>
          <div className="stat-card">
            <div className="stat-icon"><Users size={24} /></div>
            <div className="stat-info"><h3>{stats.managers}</h3><p>{t('orgManagers')}</p></div>
          </div>
        </div>

        <div className="organigramme-controls">
          <div className="search-box filter-box">
            <select
              value={groupView ? GROUP_CHART : selectedPlant}
              onChange={(event) => {
                if (event.target.value === GROUP_CHART) {
                  setGroupView(true);
                  return;
                }
                setGroupView(false);
                setPlantFilter(event.target.value);
              }}
              className="search-input filter-select"
            >
              <option value={GROUP_CHART}>{t('orgGroupChart')}</option>
              {canFilterByPlant && !isGroupHr && <option value="">{t('teamFilterAll')}</option>}
              {(canFilterByPlant ? plantOptions : plantOptions.slice(0, 1)).map((plant) => (
                <option key={plant} value={plant}>
                  {plant}
                </option>
              ))}
            </select>
          </div>

          {!groupView && (
            <div className="search-box">
              <input
                type="text"
                placeholder={t('orgSearchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="search-input"
              />
            </div>
          )}

          <div className="controls-group">
            <div className="zoom-controls">
              <button
                onClick={() => zoomRef.current && d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 0.8)}
                className="zoom-btn"
                title={t('orgZoomMinus')}
              >
                <ZoomOut size={20} />
              </button>
              <span className="zoom-level">{Math.round(zoomLevel * 100)}%</span>
              <button
                onClick={() => zoomRef.current && d3.select(svgRef.current).transition().duration(300).call(zoomRef.current.scaleBy, 1.2)}
                className="zoom-btn"
                title={t('orgZoomPlus')}
              >
                <ZoomIn size={20} />
              </button>
              <button
                onClick={() => zoomRef.current && fitTransformRef.current &&
                  d3.select(svgRef.current).transition().duration(500).call(zoomRef.current.transform, fitTransformRef.current)}
                className="zoom-btn reset-btn"
                title={t('orgResetView')}
              >
                <RotateCcw size={20} />
              </button>
              {!groupView && (
                <>
                  <button
                    onClick={() => setExpandedKeys(new Set(filteredEmployees.map((emp) => employeeKey(emp))))}
                    className="zoom-btn"
                    title={t('orgExpandAll')}
                  >
                    <ChevronsDown size={20} />
                  </button>
                  <button
                    onClick={() => setExpandedKeys(new Set())}
                    className="zoom-btn"
                    title={t('orgCollapseAll')}
                  >
                    <ChevronsUp size={20} />
                  </button>
                </>
              )}
            </div>

            <div className="export-controls">
              <button onClick={printOrganigramme} className="print-btn" disabled={exporting}>
                <Printer size={18} /> {exporting ? t('orgPrinting') : t('orgPrint')}
              </button>
              <button onClick={exportToPDF} className="export-btn" disabled={exporting}>
                <Download size={18} /> {exporting ? t('orgExporting') : t('orgExportPdf')}
              </button>
            </div>
          </div>
        </div>

        <div className="organigramme-main">
          <div className="chart-container-wrapper" ref={chartWrapperRef}>
            <div className="chart-container" ref={containerRef}>
              {groupView && groupError && <p className="paie-muted" style={{ padding: 16 }}>KPI indisponible</p>}
              <svg ref={svgRef} className="organigramme-svg"></svg>
            </div>

            {selectedNode && (
              <div className="employee-details-panel">
                <div className="panel-header">
                  <h3>{t('orgEmployeeDetails')}</h3>
                  <button onClick={() => setSelectedNode(null)} className="close-btn">×</button>
                </div>
                <div className="panel-content">
                  <div className="detail-header">
                    <div className="detail-avatar">
                      {isTunisiaEmployeeRecord(selectedNode) ? (
                        <div className="avatar-placeholder">
                          {selectedNode.prenom?.charAt(0)}{selectedNode.nom?.charAt(0)}
                        </div>
                      ) : (
                        <img
                          className="detail-avatar-image"
                          src={getEmployeeAvatarSrc(selectedNode)}
                          alt={cleanName(selectedNode.prenom, selectedNode.nom)}
                          onError={(event) => {
                            event.currentTarget.onerror = null;
                            event.currentTarget.src = getEmployeeAvatarFallback(selectedNode);
                          }}
                        />
                      )}
                    </div>
                    <div className="detail-titles">
                      <h4>{cleanName(selectedNode.prenom, selectedNode.nom)}</h4>
                      <p className="detail-matricule">{t('orgMatricule')} : {selectedNode.matricule || t('orgNotProvided')}</p>
                      <p className="detail-position">{cleanPosition(selectedNode.poste)}</p>
                      <span className="detail-department">{selectedNode.site_dep || t('orgNotSpecified')}</span>
                    </div>
                  </div>
                  <div className="detail-info">
                    {selectedNode.adresse_mail && (
                      <div className="detail-row">
                        <Mail size={18} />
                        <div>
                          <span className="detail-label">Email</span>
                          <span className="detail-value">{selectedNode.adresse_mail}</span>
                        </div>
                      </div>
                    )}
                    {selectedNode.telephone && (
                      <div className="detail-row">
                        <Phone size={18} />
                        <div>
                          <span className="detail-label">{t('orgPhone')}</span>
                          <span className="detail-value">{selectedNode.telephone}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="organigramme-footer">
          <div className="footer-content">
            <div className="footer-stats">
              <span className="stat-item"><User size={14} /> {stats.total} {t('orgActiveEmployees')}</span>
              <span className="stat-item"><Briefcase size={14} /> {stats.departments} {t('orgDepartments')}</span>
              <span className="stat-item"><Users size={14} /> {stats.managers} {t('orgManagers')}</span>
              <span className="stat-item disposition-horizontal-badge">{t('orgFooterLevel1')}</span>
              <span className="stat-item disposition-vertical-badge">{t('orgFooterTeam')}</span>
            </div>
          </div>
          <div className="footer-actions">
            <button onClick={fetchEmployees} className="refresh-btn">
              <RotateCcw size={16} /> {t('orgRefresh')}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default Organigramme;
