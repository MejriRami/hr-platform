import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';
import { formatEmployeeNom, formatEmployeePrenom } from '../utils/employeeAvatar';
import { getEmployeeRole, getEmployeeSite, getEmployeeDepartment } from '../utils/employeeProfile';
import { canSeeOwnTenantSalary } from '../utils/salaryVisibility';
import { getExcelLabels, EXCEL_DATE_LOCALES, translateGender, translateStatus } from '../data/excelLabels';

export const exportToPDF = async (elementId, filename = 'statistiques-rh.pdf') => {
  try {
    const element = document.getElementById(elementId);
    if (!element) {
      throw new Error('Élément non trouvé pour l\'export PDF');
    }

    // Afficher un message de chargement
    const loadingMessage = document.createElement('div');
    loadingMessage.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 20px;
      border-radius: 10px;
      z-index: 10000;
      font-size: 16px;
    `;
    loadingMessage.textContent = 'Génération du PDF en cours...';
    document.body.appendChild(loadingMessage);

    // html2canvas can start capturing before web fonts finish loading/swapping,
    // baking in fallback-font metrics that don't match the layout's assumed
    // line heights -- a common cause of text rendering on top of itself.
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = 210; // A4 width in mm
    const pageHeight = 295; // A4 height in mm
    const margin = 10;
    const usableWidth = pageWidth - margin * 2;

    // Capture each top-level section (header, stat cards row, each chart,
    // each table) as its own image instead of one giant page-length
    // screenshot -- that previous approach sliced the single image at fixed
    // pixel heights with no regard for what was drawn there, so any card or
    // chart straddling a page boundary got cut in half and was unreadable.
    // Rendering block-by-block and only breaking the page *between* blocks
    // guarantees nothing is ever split mid-block.
    const blocks = Array.from(element.children).filter(
      (child) => child.offsetWidth > 0 && child.offsetHeight > 0
    );

    let cursorY = margin;
    let isFirstBlock = true;

    for (const block of blocks) {
      const canvas = await html2canvas(block, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        // html2canvas doesn't support backdrop-filter and mis-measures
        // elements that use it (the stat cards and header both blur their
        // background), which was the actual cause of the overlapping text --
        // stripping it only in the cloned document used for capture, never
        // touching the real page.
        onclone: (clonedDoc) => {
          clonedDoc.querySelectorAll('*').forEach((el) => {
            el.style.backdropFilter = 'none';
            el.style.webkitBackdropFilter = 'none';
          });
        }
      });
      const imgData = canvas.toDataURL('image/png');
      const imgHeight = (canvas.height * usableWidth) / canvas.width;

      if (!isFirstBlock && cursorY + imgHeight > pageHeight - margin) {
        pdf.addPage();
        cursorY = margin;
      }

      pdf.addImage(imgData, 'PNG', margin, cursorY, usableWidth, imgHeight);
      cursorY += imgHeight + 6;
      isFirstBlock = false;
    }

    // Supprimer le message de chargement
    document.body.removeChild(loadingMessage);

    pdf.save(filename);
    
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'export PDF:', error);
    alert('Erreur lors de la génération du PDF: ' + error.message);
    return false;
  }
};

// currency / getSalary: Tunisia's Statistics page passes 'TND' and its
// decrypted payroll salaries; every other tenant keeps the € / salaire_brute
// defaults. includeSalary: salary rows/column only for the Tunisian tenants
// and never for group HR (utils/salaryVisibility.js) -- decided from the
// logged-in user so every caller (Statistics, Team, Dashboard) follows it.
export const exportToExcel = (
  data,
  filename = 'statistiques-rh.xlsx',
  {
    currency = '€',
    getSalary = (emp) => parseFloat(emp.salaire_brute),
    includeSalary = canSeeOwnTenantSalary(),
  } = {}
) => {
  try {
    // Préparer les données pour Excel
    const workbook = XLSX.utils.book_new();

    // Feuille 1: Statistiques générales
    const generalStats = [
      ['Statistique', 'Valeur'],
      ['Total Employés', data.totalEmployees],
      ['Nouveaux ce mois', data.recentHires],
      ...(includeSalary ? [
        ['Masse Salariale Mensuelle', `${data.totalSalary.toLocaleString()} ${currency}`],
        ['Salaire Moyen', `${data.averageSalary.toFixed(0)} ${currency}`],
        ['Salaire Minimum', `${data.salaryStats.min.toLocaleString()} ${currency}`],
        ['Salaire Maximum', `${data.salaryStats.max.toLocaleString()} ${currency}`],
        ['Salaire Médian', `${data.salaryStats.median.toLocaleString()} ${currency}`],
      ] : []),
      ['Contrats à renouveler', data.contractsToRenew]
    ];

    // Feuille 2: Répartition par site
    const siteData = [
      ['Site', 'Nombre d\'employés', 'Pourcentage']
    ];
    Object.entries(data.bySite).forEach(([site, count]) => {
      const percentage = ((count / data.totalEmployees) * 100).toFixed(1);
      siteData.push([site, count, `${percentage}%`]);
    });

    // Feuille 3: Types de contrat
    const contractData = [
      ['Type de Contrat', 'Nombre', 'Pourcentage']
    ];
    Object.entries(data.byContract).forEach(([contract, count]) => {
      const percentage = ((count / data.totalEmployees) * 100).toFixed(1);
      contractData.push([contract, count, `${percentage}%`]);
    });

    // Feuille 4: Dernières embauches
    const recentHiresData = [
      ['Nom', 'Prénom', 'Poste', 'Date d\'embauche', 'Département', 'Type de Contrat',
       ...(includeSalary ? ['Salaire Brut'] : [])]
    ];
    data.recentHiresList?.forEach(emp => {
      recentHiresData.push([
        emp.nom,
        emp.prenom,
        emp.poste,
        new Date(emp.date_debut).toLocaleDateString('fr-FR'),
        emp.site_dep,
        emp.type_contrat,
        ...(includeSalary ? [`${getSalary(emp).toLocaleString()} ${currency}`] : [])
      ]);
    });

    // Créer les feuilles
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(generalStats), 'Statistiques Générales');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(siteData), 'Par Site');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(contractData), 'Types de Contrat');
    if (data.recentHiresList && data.recentHiresList.length > 0) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(recentHiresData), 'Dernières Embauches');
    }

    // Générer le fichier Excel
    XLSX.writeFile(workbook, filename);
    
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'export Excel:', error);
    alert('Erreur lors de la génération du fichier Excel: ' + error.message);
    return false;
  }
};

export const exportEmployeesToExcel = (
  employees,
  filename = 'liste-employes.xlsx',
  {
    currency = '€',
    getSalary = (emp) => emp.salaire_brute,
    includeSalary = canSeeOwnTenantSalary(),
    // UI language: headers, sheet name, dates and gender/status values follow it.
    language = 'fr',
  } = {}
) => {
  try {
    const workbook = XLSX.utils.book_new();
    const L = getExcelLabels(language);
    const dateLocale = EXCEL_DATE_LOCALES[language] || 'fr-FR';

    // Some tenants (non-Tunisia) don't collect cin/passeport/date_naissance,
    // so these can be missing -- fall back to blank instead of "Invalid Date"/"NaN €".
    const formatDate = (value) => {
      if (!value) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(dateLocale);
    };
    const formatSalary = (value) => {
      const num = parseFloat(value);
      return Number.isNaN(num) ? '' : `${num.toLocaleString()} ${currency}`;
    };

    const employeeData = [
      [L.matricule, L.lastName, L.firstName, L.cin, L.passport, L.passportIssue,
       L.passportExpiry, L.birthDate, L.gender, L.position, L.grade,
       L.siteDepartment, L.contractType, L.hireDate, L.contractEnd,
       L.departureDate, L.status, ...(includeSalary ? [L.grossSalary] : []), L.email, L.manager1Email,
       L.manager2Email, L.functionalManagerEmail]
    ];

    employees.forEach(emp => {
      employeeData.push([
        emp.matricule,
        formatEmployeeNom(emp.nom),
        formatEmployeePrenom(emp.prenom),
        emp.cin || 'N/A',
        emp.passeport || 'N/A',
        formatDate(emp.date_emission_passport),
        formatDate(emp.date_expiration_passport),
        formatDate(emp.date_naissance),
        translateGender(emp.sexe || emp.gender, L),
        // getEmployeeRole applies the same SAHEL poste translation/override
        // (group_hr viewers only) as the Team card and Employee modal, so
        // this matches what's shown on screen instead of the raw DB value.
        getEmployeeRole(emp) || emp.poste,
        emp.grade || '',
        getEmployeeSite(emp) || getEmployeeDepartment(emp) || emp.site_dep,
        emp.type_contrat,
        formatDate(emp.date_debut),
        formatDate(emp.date_fin_contrat),
        formatDate(emp.date_depart),
        translateStatus(emp.statut, L),
        ...(includeSalary ? [formatSalary(getSalary(emp))] : []),
        emp.adresse_mail || '',
        emp.mail_responsable1 || '',
        emp.mail_responsable2 || '',
        emp.mail_responsable_fonctionnel || ''
      ]);
    });

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(employeeData), L.sheetList.slice(0, 31));
    XLSX.writeFile(workbook, filename);
    
    return true;
  } catch (error) {
    console.error('Erreur export employés Excel:', error);
    alert('Erreur lors de l\'export des employés: ' + error.message);
    return false;
  }
};