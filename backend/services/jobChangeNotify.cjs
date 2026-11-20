'use strict';

/**
 * Job change email (2026-11-02, Sam GARCIA / Robin FAURE's
 * "organizational changes" thread): IATF requires the competence steps below
 * whenever someone changes position, so every change of an active employee's
 * job title (poste) -- an HR edit, the bulk import or the KPI sync -- emails
 * the site's local HR, copying Group HR (Sam) and Quality (Robin,
 * Quinn, Jordan). All positions, not only quality ones (Sam). A first title
 * (new hire) is not a change.
 *
 * Sent through the Microsoft 365 mailer, so M365_MAIL_REDIRECT also catches
 * these emails on a local server.
 */

const { sendM365Mail, escapeHtml, detailsTable } = require('./m365/mail.cjs');

const GROUP_HR_EMAIL = 'sam.garcia@example.com';
const QUALITY_CC = [
  'robin.faure@example.com',
  'quinn.faure@example.com',
  'jordan.rossi@example.com',
];

// The local HR of each site (their HR app accounts, confirmed by the developer). SAHEL,
// CARTHAGE and Luxembourg HQ have none: Group HR receives the email directly.
const LOCAL_HR = {
  loire: ['riley.costa@example.com'],
  poitiers: ['alex.andre@example.com'],
  mexico: ['leslie.novak@example.com'],
  atlas: ['dana.andre@example.com'],
  chennai: ['jordan.faure@example.com'],
  tianjin: ['jules.martin@example.com'],
  kunshan: ['sacha.weber@example.com', 'riley.costa@example.com'],
  daegu: ['dana.laurent@example.com'],
};

// The plant's language (Sam GARCIA, 2026-11-03): Chinese for Tianjin and
// Kunshan, Spanish for Monterrey, Korean for Korea, French for Poitiers,
// Amiens (Loire) and Tunisia (SAHEL included), English elsewhere (India,
// Luxembourg).
const LANGUAGE_OF_SCHEMA = {
  public: 'fr',
  schema_tn: 'fr',
  schema_fr: 'fr',
  schema_cn: 'zh',
  schema_mx: 'es',
  schema_kr: 'ko',
};

const norm = (value) => String(value ?? '').trim();
const siteKey = (site) => norm(site).toLowerCase().replace(/^site[-\s]+/, '');

// SAHEL's site_dep is a department, never a site
const localHrOf = (schema, site) => (schema === 'public' ? [] : LOCAL_HR[siteKey(site)] || []);

function recipientsFor(schema, site) {
  const localHr = localHrOf(schema, site);
  return localHr.length
    ? { to: localHr, cc: [GROUP_HR_EMAIL, ...QUALITY_CC] }
    : { to: [GROUP_HR_EMAIL], cc: QUALITY_CC };
}

const TEXT = {
  fr: {
    subject: (name) => `Changement de poste – ${name} – actions IATF`,
    hello: 'Bonjour,',
    intro: (name) => `Le poste de <strong>${name}</strong> a été modifié dans l'application RH.`,
    oldTitle: 'Ancien poste',
    newTitle: 'Nouveau poste',
    ask: 'Pour la conformité IATF, merci de :',
    steps: [
      'Mettre à jour la description de poste (nouvelles tâches, responsabilités et autorités, indicateurs clés de performance, objectifs à atteindre, responsable direct).',
      "Identifier les éventuelles lacunes de compétences de l'employé.",
      "Élaborer un plan de formation si nécessaire, et mesurer l'efficacité de la formation.",
      "Si l'employé n'est pas encore apte à travailler en autonomie, désigner une personne pour l'accompagner et le suivre jusqu'à ce que la formation soit efficace.",
      'Informer les RH du Groupe de toute difficulté dans la mise en œuvre de ce processus.',
    ],
    employee: 'Employé',
    matricule: 'Matricule',
    site: 'Site',
    department: 'Département',
    changedBy: 'Modifié par',
    date: 'Date',
    thanks: 'Merci,<br>Application RH Northwind',
  },
  en: {
    subject: (name) => `Job change – ${name} – IATF actions`,
    hello: 'Hello,',
    intro: (name) => `The job title of <strong>${name}</strong> was changed in the HR application.`,
    oldTitle: 'Previous job title',
    newTitle: 'New job title',
    ask: 'For IATF compliance, please:',
    steps: [
      'Update the job description (new tasks, responsibilities and authorities, KPIs, targets to achieve, direct manager).',
      "Identify the employee's competence gaps, if any.",
      'Define a training plan if needed, and measure the effectiveness of the training.',
      'If the employee cannot yet work autonomously, name someone to support and monitor them until the training is effective.',
      'Inform Group HR of any difficulty in implementing this process.',
    ],
    employee: 'Employee',
    matricule: 'Employee ID',
    site: 'Site',
    department: 'Department',
    changedBy: 'Changed by',
    date: 'Date',
    thanks: 'Thanks,<br>Northwind HR application',
  },
  es: {
    subject: (name) => `Cambio de puesto – ${name} – acciones IATF`,
    hello: 'Hola,',
    intro: (name) => `El puesto de <strong>${name}</strong> fue modificado en la aplicación de RR. HH.`,
    oldTitle: 'Puesto anterior',
    newTitle: 'Nuevo puesto',
    ask: 'Para cumplir con la norma IATF, por favor:',
    steps: [
      'Actualizar la descripción del puesto (nuevas tareas, responsabilidades y autoridades, indicadores clave de desempeño, objetivos a alcanzar, jefe directo).',
      'Identificar las posibles brechas de competencias del empleado.',
      'Elaborar un plan de capacitación si es necesario y medir la eficacia de la capacitación.',
      'Si el empleado aún no puede trabajar de forma autónoma, designar a una persona que lo acompañe y le dé seguimiento hasta que la capacitación sea eficaz.',
      'Informar a RR. HH. del Grupo de cualquier dificultad en la implementación de este proceso.',
    ],
    employee: 'Empleado',
    matricule: 'Número de empleado',
    site: 'Planta',
    department: 'Departamento',
    changedBy: 'Modificado por',
    date: 'Fecha',
    thanks: 'Gracias,<br>Aplicación de RR. HH. Northwind',
  },
  zh: {
    subject: (name) => `岗位变更 – ${name} – IATF 行动`,
    hello: '您好，',
    intro: (name) => `<strong>${name}</strong> 的岗位已在人力资源系统中变更。`,
    oldTitle: '原岗位',
    newTitle: '新岗位',
    ask: '为符合 IATF 要求，请：',
    steps: [
      '更新岗位说明书（新分配的任务、职责和权限、关键绩效指标、需达成的目标、直属上级）。',
      '识别该员工可能存在的能力差距。',
      '如有需要，制定培训计划，并评估培训的有效性。',
      '如该员工尚不能独立工作，请指定一名人员对其进行辅导和跟进，直至培训取得成效。',
      '如在实施此流程中遇到任何困难，请告知集团人力资源部。',
    ],
    employee: '员工',
    matricule: '工号',
    site: '工厂',
    department: '部门',
    changedBy: '修改人',
    date: '日期',
    thanks: '谢谢！<br>Northwind 人力资源系统',
  },
  ko: {
    subject: (name) => `직무 변경 – ${name} – IATF 조치`,
    hello: '안녕하세요.',
    intro: (name) => `<strong>${name}</strong>님의 직무가 HR 애플리케이션에서 변경되었습니다.`,
    oldTitle: '이전 직무',
    newTitle: '새 직무',
    ask: 'IATF 요구사항 준수를 위해 다음을 진행해 주십시오.',
    steps: [
      '직무기술서를 업데이트하십시오 (새로 부여된 업무, 책임과 권한, 핵심성과지표(KPI), 달성 목표, 직속 상사).',
      '해당 직원의 역량 차이가 있는지 파악하십시오.',
      '필요한 경우 교육 계획을 수립하고 교육의 효과성을 평가하십시오.',
      '직원이 아직 독립적으로 업무를 수행할 수 없는 경우, 교육이 효과를 거둘 때까지 지원하고 모니터링할 담당자를 지정하십시오.',
      '이 프로세스를 실행하는 데 어려움이 있으면 그룹 HR에 알려 주십시오.',
    ],
    employee: '직원',
    matricule: '사번',
    site: '사업장',
    department: '부서',
    changedBy: '변경자',
    date: '날짜',
    thanks: '감사합니다.<br>Northwind HR 애플리케이션',
  },
};

// { to, cc, subject, html } for a job title change, or null when there is
// none to report (same title, first title, inactive employee).
function buildJobChangeEmail({ schema, before, after, changedBy }) {
  if (!before || !after || !('poste' in after)) return null;
  if (after.statut && after.statut !== 'actif') return null;
  const oldTitle = norm(before.poste);
  const newTitle = norm(after.poste);
  if (!oldTitle || !newTitle || oldTitle === newTitle) return null;

  const t = TEXT[LANGUAGE_OF_SCHEMA[schema]] || TEXT.en;
  const name = `${norm(after.prenom)} ${norm(after.nom).toUpperCase()}`.trim();
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
      <p>${t.hello}</p>
      <p>${t.intro(escapeHtml(name))}</p>
      ${detailsTable([[t.oldTitle, oldTitle], [t.newTitle, newTitle]])}
      <p style="margin-top:16px">${t.ask}</p>
      <ol>${t.steps.map((step) => `<li style="margin-bottom:4px">${escapeHtml(step)}</li>`).join('')}</ol>
      ${detailsTable([
        [t.employee, name],
        [t.matricule, after.matricule],
        ...(schema === 'public'
          ? [[t.site, 'SAHEL'], [t.department, after.site_dep]]
          : [[t.site, norm(after.site_dep).replace(/^Site[-\s]+/i, '')], [t.department, after.department]]),
        [t.changedBy, changedBy],
        [t.date, new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
      ])}
      <p>${t.thanks}</p>
    </div>`;
  return { ...recipientsFor(schema, after.site_dep), subject: t.subject(name), html };
}

// Paused (2026-11-03): the app is still being changed and every test
// edit emailed the local HR. Set back to true when the app is launched to them.
const JOB_CHANGE_EMAIL_ENABLED = false;

// Never throws: a failed email must not fail the HR update.
async function notifyJobChange({ schema, before, after, changedBy }) {
  if (!JOB_CHANGE_EMAIL_ENABLED) return false;
  try {
    const email = buildJobChangeEmail({ schema, before, after, changedBy });
    if (!email) return false;
    await sendM365Mail(email);
    return true;
  } catch (error) {
    console.error('⚠️ Email changement de poste non envoyé:', error.message);
    return false;
  }
}

module.exports = { buildJobChangeEmail, notifyJobChange, recipientsFor };
