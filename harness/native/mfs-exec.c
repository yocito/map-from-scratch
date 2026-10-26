// mfs-exec: run a native renderer and measure it from the outside.
//
//   mfs-exec <result.json> -- <cmd> [args...]
//
// Every line the child writes to stdout is echoed as "<us>\t<line>", where
// <us> is microseconds since just before fork(). That is how "@mfs mark"
// events get a timestamp without the renderer needing a clock of its own.
// When the child exits, wall time, CPU time and peak RSS (from wait4) are
// written to <result.json>.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/wait.h>

static double now_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}

static double tv_ms(struct timeval tv) { return tv.tv_sec * 1e3 + tv.tv_usec / 1e3; }

int main(int argc, char **argv) {
  if (argc < 4 || strcmp(argv[2], "--") != 0) {
    fprintf(stderr, "usage: mfs-exec <result.json> -- <cmd> [args...]\n");
    return 2;
  }
  int fds[2];
  if (pipe(fds) != 0) { perror("pipe"); return 2; }

  double t0 = now_us();
  pid_t pid = fork();
  if (pid < 0) { perror("fork"); return 2; }
  if (pid == 0) {
    dup2(fds[1], STDOUT_FILENO);
    close(fds[0]);
    close(fds[1]);
    execvp(argv[3], &argv[3]);
    perror("execvp");
    _exit(127);
  }
  close(fds[1]);

  FILE *in = fdopen(fds[0], "r");
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  while ((len = getline(&line, &cap, in)) > 0) {
    printf("%.0f\t%s", now_us() - t0, line);
    if (line[len - 1] != '\n') putchar('\n');
    fflush(stdout);
  }
  free(line);
  fclose(in);

  int status = 0;
  struct rusage ru;
  wait4(pid, &status, 0, &ru);
  double wall = (now_us() - t0) / 1e3;

  FILE *out = fopen(argv[1], "w");
  if (!out) { perror(argv[1]); return 2; }
  fprintf(out,
          "{\"wall_ms\":%.3f,\"user_ms\":%.3f,\"sys_ms\":%.3f,\"maxrss_kb\":%ld,"
          "\"exit_code\":%d,\"signal\":%d}\n",
          wall, tv_ms(ru.ru_utime), tv_ms(ru.ru_stime), ru.ru_maxrss,
          WIFEXITED(status) ? WEXITSTATUS(status) : -1,
          WIFSIGNALED(status) ? WTERMSIG(status) : 0);
  fclose(out);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
