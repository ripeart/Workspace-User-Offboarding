// Version 1.30
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Google Workspace Offboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getOUs() {
  try {
    const admin = AdminDirectory.Orgunits.list('my_customer', {
      type: 'all'
    });
    
    if (!admin.organizationUnits) {
      return [];
    }

    // Log all OUs for debugging
    admin.organizationUnits.forEach(function(ou) {
      Logger.log('OU: ' + ou.name + ' | Path: ' + ou.orgUnitPath);
    });

    // Sort OUs alphabetically by orgUnitPath
    const sortedOUs = admin.organizationUnits.slice().sort(function(a, b) {
      return a.orgUnitPath.localeCompare(b.orgUnitPath);
    });

    // Return OUs with full path as name, but remove leading slash
    return sortedOUs.map(function(ou) {
      let displayPath = ou.orgUnitPath.startsWith('/') ? ou.orgUnitPath.substring(1) : ou.orgUnitPath;
      // If the path is empty after removing '/', use the OU name (root OU)
      if (!displayPath) displayPath = ou.name;
      return {
        orgUnitPath: ou.orgUnitPath,
        name: displayPath
      };
    });
  } catch (error) {
    console.error('Error fetching OUs:', error);
    throw new Error('Failed to fetch organizational units');
  }
}

function emailExistsAnywhere(email) {
  // Check for primary email
  try {
    const user = AdminDirectory.Users.get(email);
    if (user && user.primaryEmail && user.primaryEmail.toLowerCase() === email.toLowerCase()) {
      return true;
    }
  } catch (e) {}
  // Check for alias
  let pageToken;
  do {
    const response = AdminDirectory.Users.list({
      customer: 'my_customer',
      maxResults: 100,
      pageToken: pageToken,
      fields: 'users(primaryEmail,aliases),nextPageToken'
    });
    if (response.users && response.users.length > 0) {
      for (let u of response.users) {
        if (u.aliases && u.aliases.map(a => a.toLowerCase()).includes(email.toLowerCase())) {
          return true;
        }
      }
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return false;
}

function hasAvailableBusinessStandardLicense() {
  try {
    const skuId = '1010020020';
    const productId = 'Google-Apps';
    const info = AdminLicenseManager.LicenseCounts.get(productId, skuId);
    // info.licenses: { assigned, total, inUse }
    return (info.total - info.assigned) > 0;
  } catch (e) {
    Logger.log('Failed to check license availability: ' + e.toString());
    return false;
  }
}

function isSuperAdmin() {
  try {
    // Try to list users (requires admin privileges)
    AdminDirectory.Users.list({customer: 'my_customer', maxResults: 1});
    return true;
  } catch (e) {
    return false;
  }
}

function createUser(formData) {
  try {
    // Check if user is a super admin
    if (!isSuperAdmin()) {
      throw new Error('You must be a Google Workspace super admin to use this tool.');
    }

    // Check if email exists as primary or alias
    if (emailExistsAnywhere(formData.email)) {
      throw new Error('A user or alias with this email already exists');
    }

    // Validate all required fields
    const requiredFields = {
      firstName: 'First Name',
      lastName: 'Last Name',
      email: 'Primary Email',
      title: 'Title',
      department: 'Department',
      secondaryEmail: 'Secondary Email',
      phoneNumber: 'Phone Number',
      ou: 'Organizational Unit'
    };

    // Check for missing required fields
    for (const [field, label] of Object.entries(requiredFields)) {
      if (!formData[field]) {
        throw new Error(`${label} is required`);
      }
    }

    // Get the domain from the admin email
    const adminEmail = Session.getActiveUser().getEmail();
    const domain = adminEmail.split('@')[1];

    // Validate email format
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(formData.email)) {
      throw new Error('Invalid primary email format');
    }

    // Validate secondary email format
    if (!emailRegex.test(formData.secondaryEmail)) {
      throw new Error('Invalid secondary email format');
    }

    // Ensure primary email is using the correct domain
    if (!formData.email.endsWith('@' + domain)) {
      throw new Error('Primary email must use the organization domain: @' + domain);
    }

    // Validate phone number format: +<countrycode><number>, 8-15 digits, no spaces/dashes
    const phoneRegex = /^\+\d{8,15}$/;
    if (!phoneRegex.test(formData.phoneNumber)) {
      throw new Error('Phone number must include country code and be 8-15 digits, e.g., +14165551234');
    }

    // Create the user object
    const password = generatePassword();
    const user = {
      primaryEmail: formData.email,
      name: {
        givenName: formData.firstName,
        familyName: formData.lastName
      },
      password: password,
      changePasswordAtNextLogin: true,
      organizations: [{
        title: formData.title,
        department: formData.department,
        primary: true
      }],
      orgUnitPath: formData.ou,
      emails: [{
        address: formData.secondaryEmail,
        type: 'work'
      }],
      phones: [{
        value: formData.phoneNumber,
        type: 'work'
      }]
    };

    // Add manager relation if provided
    if (formData.manager) {
      user.relations = [{
        type: 'manager',
        value: formData.manager
      }];
    }

    // Create the user
    const createdUser = AdminDirectory.Users.insert(user);

    // Log the creation
    Logger.log('User created successfully: ' + formData.email);

    return { 
      success: true, 
      message: 'User created successfully',
      user: {
        email: createdUser.primaryEmail,
        name: formData.firstName + ' ' + formData.lastName,
        department: formData.department,
        title: formData.title,
        manager: formData.manager,
        managerName: formData.managerName
      }
    };
  } catch (error) {
    Logger.log('Error creating user: ' + error.toString());
    throw new Error('Failed to create user: ' + error.message);
  }
}

function generatePassword() {
  // Google Workspace password requirements:
  // - At least 13 characters (per your policy)
  // - At least one uppercase, one lowercase, one number, one special character
  // - No common words

  const length = 16; // Use 16 for extra safety
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const special = '!@#$%^&*()-_=+[]{};:,.<>?';

  // Ensure at least one of each required character type
  let password = '';
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += special[Math.floor(Math.random() * special.length)];

  // Fill the rest randomly
  const allChars = uppercase + lowercase + numbers + special;
  for (let i = password.length; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle the password to ensure randomness
  password = password.split('').sort(() => Math.random() - 0.5).join('');

  Logger.log('Generated password: ' + password);
  return password;
}

function getAllUsers() {
  try {
    const users = [];
    let pageToken;
    do {
      const response = AdminDirectory.Users.list({
        customer: 'my_customer',
        maxResults: 100,
        orderBy: 'givenName',
        pageToken: pageToken,
        query: 'isSuspended=false',
        fields: 'users(primaryEmail,name/fullName),nextPageToken'
      });
      if (response.users && response.users.length > 0) {
        response.users.forEach(function(user) {
          users.push({
            email: user.primaryEmail,
            name: user.name.fullName
          });
        });
      }
      pageToken = response.nextPageToken;
    } while (pageToken);
    return users;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw new Error('Failed to fetch users');
  }
}

function offboardUser(formData) {
  var email = formData.email;
  try {
    if (!isSuperAdmin()) {
      throw new Error('You must be a Google Workspace super admin to use this tool.');
    }

    // Log the start of the offboarding process
    Logger.log('Starting offboarding process for user: ' + email);

    // Fetch the user's manager email from Directory API
    let manager = null;
    let managerDisplay = '';
    let userDisplay = email;
    try {
      const user = AdminDirectory.Users.get(email, { projection: 'full' });
      if (user.relations && user.relations.length > 0) {
        const managerRelation = user.relations.find(r => r.type === 'manager');
        if (managerRelation && managerRelation.value) {
          manager = managerRelation.value;
          // Try to get manager's name
          try {
            const mgrUser = AdminDirectory.Users.get(manager, { projection: 'full' });
            if (mgrUser.name && mgrUser.name.fullName) {
              managerDisplay = mgrUser.name.fullName + ' <' + manager + '>';
            } else {
              managerDisplay = manager;
            }
          } catch (mgrUserErr) {
            managerDisplay = manager;
          }
        }
      }
      if (user.name && user.name.fullName) {
        userDisplay = user.name.fullName + ' <' + email + '>';
      }
    } catch (mgrErr) {
      Logger.log('Could not fetch manager from Directory API: ' + mgrErr.message);
    }

    // Generate a secure password
    const newPassword = generatePassword();
    Logger.log('Generated new secure password for user');

    // Structured action log
    let actionLog = [];

    // Suspension
    let suspensionResult = '';
    try {
      AdminDirectory.Users.update({
        suspended: true
      }, email);
      suspensionResult = 'Success';
      actionLog.push({action: 'Suspend User', result: 'Success', details: 'User suspended.'});
      Logger.log('Successfully suspended user');
    } catch (suspendError) {
      suspensionResult = 'Failed: ' + suspendError.message;
      actionLog.push({action: 'Suspend User', result: 'Failed', details: suspendError.message});
      Logger.log('Error during user suspension: ' + suspendError.toString());
      throw new Error('Failed to suspend user: ' + suspendError.message);
    }

    // Password Reset
    let passwordResetResult = '';
    try {
      AdminDirectory.Users.update({
        password: newPassword,
        changePasswordAtNextLogin: true
      }, email);
      passwordResetResult = 'Success';
      actionLog.push({action: 'Reset Password', result: 'Success', details: 'Password reset and change at next login required.'});
      Logger.log('Successfully reset password');
    } catch (passwordError) {
      passwordResetResult = 'Failed: ' + passwordError.message;
      actionLog.push({action: 'Reset Password', result: 'Failed', details: passwordError.message});
      Logger.log('Error during password reset: ' + passwordError.toString());
    }

    // Groups
    let removedGroups = [];
    let failedGroups = [];
    let groupsUserWasMemberOf = [];
    try {
      const groups = AdminDirectory.Groups.list({
        userKey: email,
        maxResults: 500
      });
      if (groups.groups && groups.groups.length > 0) {
        groups.groups.forEach(function(group) {
          groupsUserWasMemberOf.push(group.email);
        });
        const batchSize = 10;
        for (let i = 0; i < groups.groups.length; i += batchSize) {
          const batch = groups.groups.slice(i, i + batchSize);
          batch.forEach(function(group) {
            try {
              AdminDirectory.Members.remove(group.id, email);
              removedGroups.push(group.email);
              actionLog.push({action: 'Remove from Group', result: 'Success', details: group.email});
              Logger.log('Successfully removed from group: ' + group.email);
            } catch (groupError) {
              failedGroups.push(group.email);
              actionLog.push({action: 'Remove from Group', result: 'Failed', details: group.email + ': ' + groupError.message});
              Logger.log('Failed to remove from group ' + group.email + ': ' + groupError.message);
            }
          });
          if (i + batchSize < groups.groups.length) {
            Utilities.sleep(1000);
          }
        }
      }
    } catch (groupsError) {
      actionLog.push({action: 'List Groups', result: 'Failed', details: groupsError.message});
      Logger.log('Error fetching or processing groups: ' + groupsError.toString());
    }

    // Transfer Drive ownership to user in the 'manager' field, moving files to a folder in manager's My Drive
    let driveTransferSummary = '';
    if (manager) {
      try {
        // 1. Create a folder in the manager's My Drive named after the offboarded user's email
        let destFolderId = null;
        let folderName = email;
        try {
          // Search for existing folder first
          const folderSearch = Drive.Files.list({
            q: `title = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`,
            maxResults: 1
          });
          if (folderSearch.items && folderSearch.items.length > 0) {
            destFolderId = folderSearch.items[0].id;
            Logger.log('Found existing destination folder in manager My Drive: ' + folderName);
          } else {
            // Create the folder in manager's My Drive
            const newFolder = Drive.Files.insert({
              title: folderName,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [{ id: 'root' }]
            }, null, { supportsAllDrives: false });
            destFolderId = newFolder.id;
            Logger.log('Created new destination folder in manager My Drive: ' + folderName);
          }
        } catch (folderErr) {
          Logger.log('Error creating or finding destination folder: ' + folderErr.message);
          actionLog.push({action: 'Transfer Drive Ownership', result: 'Failed', details: 'Error creating or finding destination folder: ' + folderErr.message});
        }

        // 2. List all files owned by the offboarded user
        let pageToken;
        let filesTransferred = 0;
        let filesFound = 0;
        do {
          const files = Drive.Files.list({
            q: `'${email}' in owners and trashed = false`,
            pageSize: 100,
            pageToken: pageToken
          });
          if (files.items && files.items.length > 0) {
            filesFound += files.items.length;
            Logger.log('Found ' + files.items.length + ' file(s) owned by user for transfer.');
            for (let file of files.items) {
              Logger.log('Attempting to move and transfer file: ' + file.title + ' (ID: ' + file.id + ')');
              try {
                // Move file to the destination folder (add parent, remove old parents)
                Drive.Files.update({
                  parents: [{ id: destFolderId }]
                }, file.id);
                // Transfer ownership
                Drive.Permissions.insert({
                  type: 'user',
                  role: 'owner',
                  value: manager,
                  emailAddress: manager,
                  transferOwnership: true
                }, file.id);
                actionLog.push({action: 'Transfer Drive Ownership', result: 'Success', details: `Moved and transferred ownership of file: ${file.title}`});
                Logger.log('Successfully moved and transferred ownership of file: ' + file.title);
                filesTransferred++;
              } catch (fileError) {
                actionLog.push({action: 'Transfer Drive Ownership', result: 'Failed', details: `File: ${file.title} - ${fileError.message}`});
                Logger.log('Failed to move/transfer file: ' + file.title + ' - ' + fileError.message);
              }
            }
          } else {
            Logger.log('No files found for this page of results.');
          }
          pageToken = files.nextPageToken;
        } while (pageToken);
        Logger.log(`Drive transfer summary: Manager: ${manager}, Files found: ${filesFound}, Files transferred: ${filesTransferred}`);
        if (filesFound === 0) {
          driveTransferSummary = `No files found to transfer ownership to manager (${managerDisplay}).`;
          actionLog.push({action: 'Transfer Drive Ownership', result: 'Skipped', details: `No files found to transfer to manager (${managerDisplay}).`});
        } else {
          driveTransferSummary = `Attempted to move and transfer ownership of ${filesFound} file(s) to manager (${managerDisplay}). Successfully transferred ${filesTransferred}.`;
        }
      } catch (ownershipError) {
        driveTransferSummary = 'Error during drive ownership transfer: ' + ownershipError.message;
        actionLog.push({action: 'Transfer Drive Ownership', result: 'Failed', details: ownershipError.message});
        Logger.log('Error during drive ownership transfer: ' + ownershipError.message);
      }
    } else {
      driveTransferSummary = 'No manager provided for drive ownership transfer.';
      actionLog.push({action: 'Transfer Drive Ownership', result: 'Skipped', details: 'No manager provided.'});
      Logger.log('No manager provided for drive ownership transfer.');
    }
    // Add manager to the log as a bullet point
    actionLog.unshift({action: 'Manager', result: 'Info', details: managerDisplay ? managerDisplay : 'No manager found.'});

    // Delete user from custom admin roles
    try {
      const roles = AdminDirectory.RoleAssignments.list('my_customer', { userKey: email });
      if (roles.items && roles.items.length > 0) {
        for (let role of roles.items) {
          try {
            // Fetch the role's common name
            let roleName = role.roleId;
            try {
              const roleInfo = AdminDirectory.Roles.get('my_customer', role.roleId);
              if (roleInfo && roleInfo.roleName) {
                roleName = roleInfo.roleName;
              }
            } catch (roleNameErr) {}
            AdminDirectory.RoleAssignments.remove('my_customer', role.roleAssignmentId);
            actionLog.push({action: 'Delete from Custom Admin Roles', result: 'Success', details: `Removed from role: ${roleName}`});
          } catch (roleError) {
            actionLog.push({action: 'Delete from Custom Admin Roles', result: 'Failed', details: `Role: ${role.roleId} - ${roleError.message}`});
          }
        }
      } else {
        actionLog.push({action: 'Delete from Custom Admin Roles', result: 'Skipped', details: 'User had no custom admin roles.'});
      }
    } catch (roleListError) {
      actionLog.push({action: 'Delete from Custom Admin Roles', result: 'Failed', details: roleListError.message});
    }

    // Remove app-specific passwords
    try {
      const asps = AdminDirectory.Asps.list(email);
      if (asps.items && asps.items.length > 0) {
        for (let asp of asps.items) {
          try {
            AdminDirectory.Asps.delete(email, asp.codeId);
            actionLog.push({action: 'Remove App-Specific Passwords', result: 'Success', details: `Removed ASP: ${asp.codeId}`});
          } catch (aspError) {
            actionLog.push({action: 'Remove App-Specific Passwords', result: 'Failed', details: `ASP: ${asp.codeId} - ${aspError.message}`});
          }
        }
      } else {
        actionLog.push({action: 'Remove App-Specific Passwords', result: 'Skipped', details: 'No app-specific passwords found.'});
      }
    } catch (aspListError) {
      actionLog.push({action: 'Remove App-Specific Passwords', result: 'Failed', details: aspListError.message});
    }

    // Revoke OAuth tokens
    try {
      AdminDirectory.Tokens.list(email).items?.forEach(token => {
        try {
          AdminDirectory.Tokens.remove(email, token.clientId);
          actionLog.push({action: 'Revoke OAuth Tokens', result: 'Success', details: `Revoked token: ${token.clientId}`});
        } catch (tokenError) {
          actionLog.push({action: 'Revoke OAuth Tokens', result: 'Failed', details: `Token: ${token.clientId} - ${tokenError.message}`});
        }
      });
      actionLog.push({action: 'Revoke OAuth Tokens', result: 'Completed', details: 'All tokens processed.'});
    } catch (tokenListError) {
      actionLog.push({action: 'Revoke OAuth Tokens', result: 'Failed', details: tokenListError.message});
    }

    // Sign user out of all sessions
    try {
      AdminDirectory.Users.signOut(email);
      actionLog.push({action: 'Sign Out of All Sessions', result: 'Success', details: 'User signed out of all sessions.'});
    } catch (signOutError) {
      actionLog.push({action: 'Sign Out of All Sessions', result: 'Failed', details: signOutError.message});
    }

    // Prepare the success message with detailed information
    let message = 'User offboarded successfully!\n\n';
    message += '- New password: ' + newPassword + '\n';
    if (failedGroups.length > 0) {
      message += '\n\nNote: Failed to remove from ' + failedGroups.length + ' groups:';
      failedGroups.forEach(group => {
        message += '\n- ' + group;
      });
    }

    Logger.log('Offboarding process completed successfully');
    return {
      success: true,
      message: message,
      log: actionLog,
      userDisplay: userDisplay,
      newPassword: newPassword,
      managerDisplay: managerDisplay
    };
  } catch (error) {
    Logger.log('Error in offboarding process: ' + error.toString());
    throw new Error('Failed to offboard user: ' + error.message);
  }
}

function testListDrives() {
  Logger.log('Function started');
  let pageToken;
  do {
    const drivesResponse = Drive.Drives.list({
      pageSize: 100,
      pageToken: pageToken
    });
    Logger.log('drivesResponse: ' + JSON.stringify(drivesResponse));
    if (drivesResponse.drives && drivesResponse.drives.length > 0) {
      for (let drive of drivesResponse.drives) {
        Logger.log('Drive: ' + drive.name + ' (ID: ' + drive.id + ')');
      }
    }
    pageToken = drivesResponse.nextPageToken;
  } while (pageToken);
} 
