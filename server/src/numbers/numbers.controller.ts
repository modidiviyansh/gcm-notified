import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { NumbersService } from './numbers.service';
import { LEVELS } from './warmup';

@Controller('numbers')
export class NumbersController {
  constructor(private readonly numbers: NumbersService) {}

  @Get() list() { return this.numbers.list(); }
  @Get('levels') levels() { return LEVELS; }
  @Post() create(@Body() body: any) { return this.numbers.create(body); }
  @Put(':id') update(@Param('id', ParseIntPipe) id: number, @Body() body: any) { return this.numbers.update(id, body); }
  @Delete(':id') remove(@Param('id', ParseIntPipe) id: number) { return this.numbers.remove(id); }

  @Post(':id/pause') pause(@Param('id', ParseIntPipe) id: number) { return this.numbers.setPaused(id, true); }
  @Post(':id/resume') resume(@Param('id', ParseIntPipe) id: number) { return this.numbers.setPaused(id, false); }
  // Express 5 routing has no inline regex params, so each action gets its own route
  @Post(':id/start') start(@Param('id', ParseIntPipe) id: number) { return this.numbers.action(id, 'start'); }
  @Post(':id/stop') stop(@Param('id', ParseIntPipe) id: number) { return this.numbers.action(id, 'stop'); }
  @Post(':id/restart') restart(@Param('id', ParseIntPipe) id: number) { return this.numbers.action(id, 'restart'); }
  @Post(':id/logout') logout(@Param('id', ParseIntPipe) id: number) { return this.numbers.action(id, 'logout'); }

  @Get(':id/qr')
  async qr(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const img = await this.numbers.qr(id);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(img);
  }
  @Post(':id/pairing-code') code(@Param('id', ParseIntPipe) id: number, @Body() b: { phone: string }) { return this.numbers.pairingCode(id, b.phone); }

  @Get(':id/groups') groups(@Param('id', ParseIntPipe) id: number) { return this.numbers.groups(id); }
  @Post(':id/groups/refresh') refreshGroups(@Param('id', ParseIntPipe) id: number) { return this.numbers.refreshGroups(id); }
}
