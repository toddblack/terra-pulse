/**
 * Real 512-byte records, captured 2026-09-10 UTC from the EarthScope ring
 * (`rtserve.iris.washington.edu:18000`, SeedLink 3.1).
 *
 * The expected values below were derived by a separate throwaway script
 * reading the raw bytes, not by the parser under test, so these assertions are
 * not the parser agreeing with itself. X0/Xn are the record's own integration
 * constants — the parser landing on Xn is the proof the Steim-2 decode is right.
 *
 * Two have blank location codes and one (`IU AFI 10`) does not, which is the
 * mix the ring actually carries: blank on 95-100% of regional stations, real
 * codes on nearly all of the global network.
 */
export const MS2_FIXTURES = {
  CI_ADO_HHZ:
    'ODI0Mjg3RCBBRE8gICAgSEhaQ0kH6gD9BikCAAe/AOEAZAABACAAAgAAAAAAQAAwA+gAOAsBCQAD6QAAZF1GBwKqqqoAAApDAAAIRYFoAL3ybNoDv02CbYGb/6m9s3x0+CVF0tsB+mHKgH8EgQqAzr8IgMqBKH9959sHQ4BY/3EqqqqqvviAf4EOgZXAHLSv0FG5JL/2fGu/wQKH5lrlyM//8wa+837jgKICmP+YcZ3Y3LxcgGh81b3R//OAE4FBKqqqqoJNg2q/a/1Z5jngWoFvAP1///0t8Wn2G4HphZKA630+vv7+ar3IgF6CDQGugHJ+Z76oApCCM/8GvkF8cSqqqqq+qICEgWuEEoByfTb2oGtrgTYDr7/TfWe+q3t/v68Fy4ICf3O/v/0NvgUBuoF9ACSAcIMSgGB72r88ATsqqqqqvpf/eNy5PUOCVwF2vqB9Ub/f+/S/SwWEgWoAXb+f/qe+eHwygSWFEIEygcS+R3iTv7gDqIEfgliAZX0PKqqqqr9qgrbGugRmv/D9ML66AXSB9AQAgZB767sh/aqCJQJGgSiBfr8vgEeBUYEOv4V9m+duv6XT1Gu+v89+viqqqqq+fv7SgR4ChYEpgE2+R30dgRGDCtUmCwC++X5D8xcUh4BVgDK96fvWgFUEJYJYgNG983wPv6YEJYE6fz0=',
  NN_BMHS_HHZ:
    'MDAwMDAxRCBCTUhTICAgSEhaTk4H6gD9Big5AA9bAOcAZAABAAAAAgAAAAAAQAAwA+gAOAsBCQAD6QAAAB4AAAKqqqoAAC4VAAAt0YGHfpTgRfUNv1//fYFAfbS/pALtvv5/AdGx8jO/loM+/Jk8kt4gNrGB6IAKvZiBvYEgfNYqqqqqv5YDpr9L/YOBlv48vqWDWIAN/PuANYLAvzx/qYHrfd6/agJxgJAAWb5BAEWBEX5VgGF/bL6gAFWByX+4Kqqqqr3PAZmAZ/6tgaN/z+aCmB/9S7EvxP6JSujAq+y/0wJ8vpT8yoERgg/GIMzSvyp/rYEVfj39Jl6h9sGs8CaqqqrCPYzF+LduDb7m/s6BXf7ZvumCZNHaO/iBlf9/vpkBSsZw34ruH0ZggWQBeL5WgM/fPHI02J3KJ4IW/ssqqqqqvooC480O69bLeqo0gXr/dL7IfxeAZ4N246s95uXdIaeAMvyfgMuD/b25gI+B9/20gBUBX77N/lqB+wE8Kqqqqr4C/4iAwYIEv8X9cP7OrYOAUfzkv18BbYHV/pi+NQN3v+f+zYF7fY2/IQQrgN370b+Xg4i+z//gghr9FCqqqqq94IKNgoH+4b3ZAHLGGhyBgLh/Tb7gAmqAtf0hgQeB2r5yfnKBiADCvv2DAr8ve+uCDgE2vfyAJ4Io/pk=',
  IU_AFI_BHZ:
    'MDc4MDM2RCBBRkkgIDEwQkhaSVUH6gD9Big3ACTlAM4AKAABACAAAgAAAAAAQAAwA+gAOAsBCQAD6QAAZCZGBwKqqqoAAAi7AAAC5YAe+R+C5oDDvcoEW77k/WeAsgKwvoL614VffiK6GAnegRF2HILdgI+9kQNx+pFnFX//+R8qqqqqvdINO4SX7bm/Z4feu2oFUYVffH+3V/mJkB6KZKpxfcmSifvCtyr6noVvjEe3hIAvhUh0coMghAe5uQX2KqqqqoAD/LGEn3Z6vo0H17qfh+eGVm6wvO8JTYDr/n69+gHxgjj69r1hBRKDsPyDu9uAjoLwA7S+zvtLgkX9jCqqqqq9p4lyvqL5OYHHBleBSHOrv8SMXL5x+6i+1X83hRz/nbrTggKChIB2gUD/DLzHgJ+Bcf1LgsMC8LrqhPIqqqqqhGx5mr7ef76AdoOu7AmNaoC2fa2Ae4Rnvpp7zIHngbe9xQMngMv6BIESg6u/M/xCgSIHcry2eudAAAkyKqqqqoHG+P27/wRXhot9A7pohfiCaXfjv12C54GFBZW8afzHgzn7z4EXgJm+/wTXvhkBUIKC+6q83YL/hDr8wyqqqqq+Z4LRvr6AR784AMuEW3yZvMsCRoBbfCaBS4Pdvx8C5b8m/RKAegFJgR58rb60ATGB7ANUvs/9vr/8/Kc=',
} as const;
