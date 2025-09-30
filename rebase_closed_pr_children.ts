/**
 * this should:
 * 
 * 1. fetch from origin
 * 2. check what PRs we had previously tracked are now merged
 * 3. for each of these, look at the children commits
 * 4. rebase each one onto latest `main`
 * 5. push each
 * 
 */