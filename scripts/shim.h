/* Force-included (-include) when building the reference encoder, see build-reference.sh.
 *
 * libmp3lame calls the single precision powf() and log10f(). Unlike the IEEE basic operations
 * their results are not specified to the last bit, and C libraries really do differ there
 * (Apple's libm, glibc and musl each round a few inputs differently). lame-ts computes these
 * two functions in double precision and rounds the result to float, so the reference build is
 * told to do the same, which makes its output independent of the C library's float variants. */
#ifndef LAMETS_SHIM_H
#define LAMETS_SHIM_H
#include <math.h>
static inline float lamets_powf(float x, float y) { return (float) pow((double) x, (double) y); }
static inline float lamets_log10f(float x) { return (float) log10((double) x); }
#undef powf
#undef log10f
#define powf lamets_powf
#define log10f lamets_log10f
#endif
