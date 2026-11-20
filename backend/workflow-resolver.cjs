const DEFAULT_HR_EMAIL = process.env.HR_MANAGER_EMAIL || process.env.HR_EMAIL || null;

const normalizePlant = (employee = {}) =>
  String(employee.site_dep || employee.department || employee.site || '').trim().toLowerCase();

const normalizeStaffGrade = (employee = {}) =>
  String(employee.grade || employee.niveau || employee.level || '').trim().toLowerCase();

const getLeaveDurationDays = (request = {}) => {
  if (request.date_depart && request.date_retour) {
    const start = new Date(request.date_depart);
    const end = new Date(request.date_retour);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
      return Math.max(1, diff + 1);
    }
  }
  return Number(request.demi_journee ? 0.5 : 1);
};

const isLeaveRequest = (type) =>
  ['congé', 'conge', 'leave', 'autorisation_absence', 'autorisation', 'absence'].includes(String(type || '').toLowerCase());

const getTianjinWorkflow = ({ employee, request }) => {
  const grade = normalizeStaffGrade(employee);
  const durationDays = getLeaveDurationDays(request);

  if (grade.includes('manager')) {
    return {
      steps: ['applicant', 'plant_manager', 'hr'],
      finalStep: 'hr',
      notes: 'Manager: Applicant → Plant Manager → HR.'
    };
  }

  if (grade.includes('office')) {
    return durationDays <= 2
      ? {
          steps: ['applicant', 'supervisor', 'manager', 'hr'],
          finalStep: 'hr',
          notes: 'Office staff: up to 2 days ends at HR.'
        }
      : {
          steps: ['applicant', 'supervisor', 'manager', 'hr', 'plant_manager'],
          finalStep: 'plant_manager',
          notes: 'Office staff: 3+ days adds Plant Manager.'
        };
  }

  return durationDays <= 1
    ? {
        steps: ['applicant', 'team_leader', 'supervisor', 'manager'],
        finalStep: 'manager',
        notes: 'Direct/Indirect staff: 1 day or less ends at Manager.'
      }
    : durationDays <= 2
      ? {
          steps: ['applicant', 'team_leader', 'supervisor', 'manager', 'hr'],
          finalStep: 'hr',
          notes: 'Direct/Indirect staff: up to 2 days adds HR.'
        }
      : {
          steps: ['applicant', 'team_leader', 'supervisor', 'manager', 'hr', 'plant_manager'],
          finalStep: 'plant_manager',
          notes: 'Direct/Indirect staff: 3+ days adds Plant Manager.'
        };
};

const getPlantWorkflow = ({ plant, requestType, employee, request }) => {
  const normalizedPlant = normalizePlant({ site_dep: plant });
  const workflow = {
    steps: ['supervisor', 'hr'],
    finalStep: 'hr',
    notifyRoles: ['supervisor', 'hr'],
    notes: ''
  };

  if (normalizedPlant.includes('germany')) {
    return { steps: ['sage'], finalStep: 'sage', notifyRoles: ['sage'], notes: 'Germany is managed in SAGE.' };
  }

  if (normalizedPlant.includes('loire') || normalizedPlant.includes('poitiers')) {
    return { steps: ['supervisor', 'hr'], finalStep: 'hr', notifyRoles: ['supervisor', 'hr'], notes: 'Supervisor then HR.' };
  }

  if (normalizedPlant.includes('mexco')) {
    return {
      steps: ['supervisor', 'plant_director', 'hr'],
      finalStep: 'hr',
      notifyRoles: ['supervisor', 'plant_director', 'hr'],
      notes: 'Supervisor, plant director, then HR.'
    };
  }

  if (normalizedPlant.includes('india')) {
    return {
      steps: ['supervisor', 'hierarchical_manager', 'hr'],
      finalStep: 'hr',
      notifyRoles: ['supervisor', 'hierarchical_manager', 'hr'],
      notes: 'Supervisor, hierarchical manager, then HR.'
    };
  }

  if (normalizedPlant.includes('kunshan')) {
    return {
      steps: ['supervisor', 'department_manager', 'hr'],
      finalStep: 'hr',
      notifyRoles: ['supervisor', 'department_manager', 'hr'],
      notes: 'Supervisor, department manager, then HR.'
    };
  }

  if (normalizedPlant.includes('tianjin')) {
    return getTianjinWorkflow({ employee, request });
  }

  if (isLeaveRequest(requestType)) {
    return workflow;
  }

  return workflow;
};

const getWorkflowEmails = ({ employee = {}, request = {}, requesterEmail = null }) => {
  const plant = normalizePlant(employee);
  const supervisor = employee.mail_responsable1 || null;
  const second = employee.mail_responsable2 || null;
  const hr = DEFAULT_HR_EMAIL;

  if (plant.includes('germany')) return [];
  if (plant.includes('loire') || plant.includes('poitiers')) return [supervisor, hr].filter(Boolean);
  if (plant.includes('mexco')) return [supervisor, employee.plant_director_email || null, hr].filter(Boolean);
  if (plant.includes('india')) return [supervisor, employee.hierarchical_manager_email || null, hr].filter(Boolean);
  if (plant.includes('kunshan')) return [supervisor, employee.department_manager_email || null, hr].filter(Boolean);

  if (plant.includes('tianjin')) {
    const workflow = getTianjinWorkflow({ employee, request });
    const emails = [];

    for (const step of workflow.steps) {
      if (step === 'applicant') {
        if (requesterEmail) emails.push(requesterEmail);
      } else if (step === 'team_leader') {
        emails.push(employee.team_leader_email || supervisor);
      } else if (step === 'supervisor') {
        emails.push(supervisor);
      } else if (step === 'manager') {
        emails.push(employee.manager_email || employee.hierarchical_manager_email || second);
      } else if (step === 'hr') {
        emails.push(hr);
      } else if (step === 'plant_manager') {
        emails.push(employee.plant_manager_email || employee.department_manager_email || hr);
      }
    }

    return emails.filter(Boolean);
  }

  return [supervisor, second || hr].filter(Boolean);
};

module.exports = {
  getPlantWorkflow,
  getWorkflowEmails,
  normalizePlant,
  normalizeStaffGrade,
  getLeaveDurationDays,
};
