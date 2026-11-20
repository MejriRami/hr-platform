// The training-platform account request (Sacha + Sam) needs the new hire's
// work email, but outside Tunisia that email is only created by IT after the
// onboarding requests go out (group HR, 2026-10-22). So when the employee has
// no email yet, onboarding parks the request as an onboarding_tasks row and it
// is sent the first time the employee's email is saved.

const TRAINING_CONTACT_EMAIL = 'sacha.moreau@example.com';
const TRAINING_PLATFORM_ACCOUNT_EMAIL = 'sam.garcia@example.com';
const TRAINING_RECIPIENTS = [TRAINING_CONTACT_EMAIL, TRAINING_PLATFORM_ACCOUNT_EMAIL].join(', ');
const TRAINING_REQUEST_TASK_CODE = 'training_request';
// FranceOnboarding.jsx writes this placeholder in the body while the email
// is still unknown; it is swapped for the real address at send time.
const WORK_EMAIL_PLACEHOLDER = '[work email]';

const buildTrainingSubject = (employeeName) => `Training request — ${employeeName || 'new hire'}`;

const fillWorkEmail = (body, workEmail) =>
  workEmail ? String(body).split(WORK_EMAIL_PLACEHOLDER).join(workEmail) : String(body);

const sendTrainingEmail = ({ emailTransporter, from, subject, body, workEmail }) =>
  emailTransporter.sendMail({
    from,
    to: TRAINING_RECIPIENTS,
    subject,
    text: fillWorkEmail(body, workEmail)
  });

const queueTrainingRequest = async (pool, schema, employeeId, { employeeName, body, createdBy }) => {
  const record = await pool.query(
    `INSERT INTO ${schema}.onboarding_records (employee_id, status, created_by) VALUES ($1,'in_progress',$2)
     ON CONFLICT (employee_id) DO UPDATE SET updated_at=CURRENT_TIMESTAMP RETURNING id`,
    [employeeId, createdBy || null]
  );
  await pool.query(
    `INSERT INTO ${schema}.onboarding_tasks (onboarding_id, task_code, title, description, assignee_email, sort_order)
     VALUES ($1,$2,$3,$4,$5,0)`,
    [record.rows[0].id, TRAINING_REQUEST_TASK_CODE, buildTrainingSubject(employeeName), body, TRAINING_CONTACT_EMAIL]
  );
};

// Claims every pending training request of this employee (marking it done
// first so two concurrent saves can't both send it), sends it, and puts it
// back to its previous status if the email fails so the next save retries.
const sendPendingTrainingRequests = async ({ pool, emailTransporter, from, schema, employeeId, workEmail }) => {
  if (!schema || schema === 'public' || !employeeId || !workEmail) return 0;

  const claimed = await pool.query(
    `UPDATE ${schema}.onboarding_tasks t
        SET status='done', completed_at=CURRENT_TIMESTAMP
       FROM (
         SELECT ot.id, ot.status AS previous_status
           FROM ${schema}.onboarding_tasks ot
           JOIN ${schema}.onboarding_records r ON r.id = ot.onboarding_id
          WHERE r.employee_id = $1
            AND ot.task_code = $2
            AND ot.status IS DISTINCT FROM 'done'
          FOR UPDATE OF ot
       ) pending
      WHERE t.id = pending.id
      RETURNING t.id, t.title, t.description, pending.previous_status`,
    [employeeId, TRAINING_REQUEST_TASK_CODE]
  );

  let sent = 0;
  for (const task of claimed.rows) {
    try {
      await sendTrainingEmail({ emailTransporter, from, subject: task.title, body: task.description, workEmail });
      sent++;
    } catch (error) {
      console.error(`❌ Training request (task ${task.id}) not sent, will retry on next email save:`, error.message);
      await pool.query(
        `UPDATE ${schema}.onboarding_tasks SET status=$1, completed_at=NULL WHERE id=$2`,
        [task.previous_status, task.id]
      );
    }
  }
  if (sent) console.log(`📧 Pending training request sent for employee ${employeeId} (${schema}) to ${TRAINING_RECIPIENTS}`);
  return sent;
};

module.exports = {
  TRAINING_CONTACT_EMAIL,
  TRAINING_PLATFORM_ACCOUNT_EMAIL,
  buildTrainingSubject,
  sendTrainingEmail,
  queueTrainingRequest,
  sendPendingTrainingRequests
};
