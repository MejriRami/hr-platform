import React from 'react';
import './EmployeeCard.css';
import {
  getEmployeeAvatarFallback,
  getEmployeeAvatarSrc,
  getEmployeeDisplayName
} from '../utils/employeeAvatar';
import {
  getEmployeeDepartment,
  getEmployeeGrade,
  getEmployeeRole,
  getEmployeeSite
} from '../utils/employeeProfile';
import { getCurrentUser, isGlobalHrManager } from '../services/api';

const EmployeeCard = ({ employee, onClick }) => {
  const employeeName = getEmployeeDisplayName(employee);
  const avatarFallback = getEmployeeAvatarFallback(employee);
  const employeeRole = getEmployeeRole(employee);
  const employeeGrade = getEmployeeGrade(employee);
  // For group HR, SAHEL employees get their group department here (never the
  // SAHEL-internal site_dep label) -- see getEmployeeDepartment.
  const employeeDepartment = getEmployeeDepartment(employee);
  const employeeSite = getEmployeeSite(employee);
  // group_hr sees grades as plain text (no color/star badge); other tenants unchanged.
  const isGroupHrUser = isGlobalHrManager(getCurrentUser());

  return (
    <div className="employee-card" onClick={() => onClick(employee)}>
      <div className="team-card-header">
        <img 
          src={getEmployeeAvatarSrc(employee)}
          alt={employeeName}
          className="employee-photo"
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = avatarFallback;
          }}
        />
        <div className="team-employee-info">
          <h3
            className="team-employee-name"
          >
            {employeeName}
          </h3>
          
        </div>
      </div>
      <div className="card-body">
        {employeeRole && <p className="employee-role">{employeeRole}</p>}
        {employeeGrade ? (
          <p className={`employee-grade${isGroupHrUser ? ' grade-plain' : ''}`}>{employeeGrade}</p>
        ) : (
          employeeDepartment && <p className="employee-department">{employeeDepartment}</p>
        )}
        {employeeSite && <p className="employee-site">{employeeSite}</p>}
      </div>
    </div>
  );
};

// Memoized: only re-renders when its own employee/onClick change.
export default React.memo(EmployeeCard);
