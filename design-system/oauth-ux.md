## UI Pro Max Search Results
**Domain:** ux | **Query:** OAuth manual-code secure-form accessibility loading errors
**Source:** ux-guidelines.csv | **Found:** 10 results

### Result 1
- **Category:** Accessibility
- **Issue:** Form Labels
- **Platform:** All
- **Description:** Inputs must have associated labels
- **Do:** Use label with for attribute or wrap input
- **Don't:** Placeholder-only inputs
- **Code Example Good:** <label for='email'>
- **Code Example Bad:** placeholder='Email' only
- **Severity:** High

### Result 2
- **Category:** Performance
- **Issue:** Code Splitting
- **Platform:** Web
- **Description:** Large bundles slow initial load
- **Do:** Split code by route/feature
- **Don't:** Single large bundle
- **Code Example Good:** dynamic import()
- **Code Example Bad:** All code in main bundle
- **Severity:** Medium

### Result 3
- **Category:** Forms
- **Issue:** Submit Feedback
- **Platform:** All
- **Description:** Confirm form submission status
- **Do:** Show loading then success/error state
- **Don't:** No feedback after submit
- **Code Example Good:** Loading -> Success message
- **Code Example Bad:** Button click with no response
- **Severity:** High

### Result 4
- **Category:** Feedback
- **Issue:** Error Recovery
- **Platform:** All
- **Description:** Help users recover from errors
- **Do:** Provide clear next steps
- **Don't:** Error without recovery path
- **Code Example Good:** Try again button + help link
- **Code Example Bad:** Error message only
- **Severity:** Medium

### Result 5
- **Category:** Forms
- **Issue:** Error Placement
- **Platform:** All
- **Description:** Errors should appear near the problem
- **Do:** Show error below related input
- **Don't:** Single error message at top of form
- **Code Example Good:** Error under each field
- **Code Example Bad:** All errors at form top
- **Severity:** Medium

### Result 6
- **Category:** Performance
- **Issue:** Lazy Loading
- **Platform:** All
- **Description:** Load content as needed
- **Do:** Lazy load below-fold images and content
- **Don't:** Load everything upfront
- **Code Example Good:** loading='lazy'
- **Code Example Bad:** All images eager load
- **Severity:** Medium

### Result 7
- **Category:** Animation
- **Issue:** Loading States
- **Platform:** All
- **Description:** Show feedback during async operations
- **Do:** Use skeleton screens or spinners
- **Don't:** Leave UI frozen with no feedback
- **Code Example Good:** animate-pulse skeleton
- **Code Example Bad:** Blank screen while loading
- **Severity:** High

### Result 8
- **Category:** Performance
- **Issue:** Font Loading
- **Platform:** Web
- **Description:** Web fonts can block rendering
- **Do:** Use font-display swap or optional
- **Don't:** Invisible text during font load
- **Code Example Good:** font-display: swap
- **Code Example Bad:** FOIT (Flash of Invisible Text)
- **Severity:** Medium

### Result 9
- **Category:** Feedback
- **Issue:** Loading Indicators
- **Platform:** All
- **Description:** Show system status during waits
- **Do:** Show spinner/skeleton for operations > 300ms
- **Don't:** No feedback during loading
- **Code Example Good:** Skeleton or spinner
- **Code Example Bad:** Frozen UI
- **Severity:** High

### Result 10
- **Category:** Interaction
- **Issue:** Loading Buttons
- **Platform:** All
- **Description:** Prevent double submission during async actions
- **Do:** Disable button and show loading state
- **Don't:** Allow multiple clicks during processing
- **Code Example Good:** disabled={loading} spinner
- **Code Example Bad:** Button clickable while loading
- **Severity:** High
