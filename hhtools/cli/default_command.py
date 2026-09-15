"""Keep explicit subcommands while allowing the historical run command by default."""

import typer
from typer.core import TyperGroup


class DefaultCommandGroup(TyperGroup):
    def parse_args(self, ctx, args):
        if args and args[0] in self.commands:
            return super().parse_args(ctx, args)
        ctx.meta["hhtools_default_args"] = args or ["--help"]
        return []

    def invoke(self, ctx):
        args = ctx.meta.pop("hhtools_default_args", None)
        if args is None:
            return super().invoke(ctx)
        command = self.get_command(ctx, "run")
        others = ", ".join(name for name in self.commands if name != "run")
        command.epilog = "The optional 'run' spelling remains compatible." + (
            " Other subcommands: " + others + "." if others else ""
        )
        with command.make_context(ctx.info_name, args, parent=ctx.parent) as direct:
            return command.invoke(direct)


def default_command_app(help_text):
    app = typer.Typer(cls=DefaultCommandGroup, help=help_text)

    @app.callback()
    def group():
        """The run spelling remains a compatibility alias."""

    return app
